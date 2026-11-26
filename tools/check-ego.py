#!/usr/bin/env python3
"""Check an upload zip against the extensions.gnome.org review rules.

Usage: tools/check-ego.py dist/<uuid>.shell-extension.zip [--shexli PATH]

Runs the static checks reviewers apply by hand, then shexli when it is
installed. Exits non-zero on any problem, so CI can gate on it.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import zipfile

MAX_BYTES = 5 * 1024 * 1024
MAX_LINE = 200
SHELL_FILES_DENY = re.compile(r"""from\s+['"]gi://(Gtk|Gdk|Adw)['"]""")
PREFS_DENY = re.compile(r"""from\s+['"]gi://(Clutter|Meta|St|Shell)['"]""")
VERSIONED_GI = re.compile(r"""['"]gi://\w+\?version=""")
FORBIDDEN = {
    r"\bGLib\.spawn_": "starts a process",
    r"\bGio\.Subprocess\b": "starts a process",
    r"\bnew_subprocess\b": "starts a process",
    r"\bUtil\.(try)?[sS]pawn": "starts a process",
    r"\bimports\.(byteArray|lang|mainloop)\b": "deprecated module",
    r"\bByteArray\b": "deprecated module",
    r"\bgetPreferencesWidget\b": "use fillPreferencesWindow on GNOME 45+",
    r"Generated with AI for personal use": "remove the personal-use notice before upload",
}
JUNK = re.compile(r"(^|/)(\.git|node_modules|venv|\.venv|dist|po|target)/|\.(po|pot|so|a|o)$|gschemas\.compiled$")
# shexli 0.2.1 treats every shell-version major above 50 as a future release.
# GNOME 51 is stable (release.gnome.org/51), so that one finding is expected.
STALE_SHEXLI = {"EGO-M-004"}


def fail(problems, message):
    problems.append(message)
    print(f"  FAIL  {message}")


def check_zip(path, problems):
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        fail(problems, f"{path} is not a valid zip")
        return None
    names = archive.namelist()
    size = sum(info.file_size for info in archive.infolist())
    if size > MAX_BYTES:
        fail(problems, f"uncompressed size {size} bytes is over the 5 MB limit")
    for required in ("metadata.json", "extension.js"):
        if required not in names:
            fail(problems, f"{required} is not at the zip root")
    if "extension.js" in names and not archive.read("extension.js").strip():
        fail(problems, "extension.js is empty")
    for name in names:
        if JUNK.search(name):
            fail(problems, f"{name} should not be shipped")
        if not name.endswith("/") and archive.read(name)[:4] == b"\x7fELF":
            fail(problems, f"{name} is a bundled binary")
    return archive


def check_metadata(archive, problems):
    try:
        meta = json.loads(archive.read("metadata.json"))
    except (KeyError, json.JSONDecodeError) as error:
        fail(problems, f"metadata.json is unreadable: {error}")
        return
    uuid = meta.get("uuid", "")
    if not re.fullmatch(r"[-a-zA-Z0-9_.]+@[-a-zA-Z0-9_.]+", uuid) or uuid.endswith("gnome.org"):
        fail(problems, f"uuid {uuid!r} is not id@namespace")
    for key in ("name", "description", "url"):
        if not meta.get(key):
            fail(problems, f"metadata.json has no {key}")
    versions = meta.get("shell-version")
    if not versions or not all(isinstance(v, str) for v in versions):
        fail(problems, "shell-version must be a non-empty list of strings")
    if "version" in meta and not isinstance(meta["version"], int):
        fail(problems, "version must be an integer (or left out)")
    if meta.get("session-modes") == ["user"]:
        fail(problems, 'drop session-modes ["user"]: it is the default')
    schema = meta.get("settings-schema")
    if schema:
        if not schema.startswith("org.gnome.shell.extensions."):
            fail(problems, f"settings-schema {schema} lacks the org.gnome.shell.extensions prefix")
        if f"schemas/{schema}.gschema.xml" not in archive.namelist():
            fail(problems, f"schemas/{schema}.gschema.xml is missing")


def check_sources(archive, problems):
    for name in archive.namelist():
        if not name.endswith(".js"):
            continue
        text = archive.read(name).decode("utf-8")
        is_prefs = name == "prefs.js" or name.startswith("prefs/")
        if VERSIONED_GI.search(text):
            fail(problems, f"{name}: gi:// import with ?version= is rejected in review")
        if is_prefs and PREFS_DENY.search(text):
            fail(problems, f"{name}: Shell libraries imported in the preferences process")
        if not is_prefs and SHELL_FILES_DENY.search(text):
            fail(problems, f"{name}: GTK libraries imported in the Shell process")
        for pattern, why in FORBIDDEN.items():
            for match in re.finditer(pattern, text):
                line = text.count("\n", 0, match.start()) + 1
                fail(problems, f"{name}:{line}: {match.group(0)} ({why})")
        for number, line in enumerate(text.splitlines(), 1):
            if len(line) > MAX_LINE:
                fail(problems, f"{name}:{number}: line is {len(line)} characters, over {MAX_LINE}")


def run_shexli(path, shexli, problems):
    binary = shexli or shutil.which("shexli")
    if not binary:
        print("  skip  shexli is not installed (pip install shexli)")
        return
    result = subprocess.run([binary, path, "--format", "json"], capture_output=True, text=True)
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError:
        fail(problems, f"shexli produced no report: {result.stderr.strip()}")
        return
    # shexli exits 0 even with findings, so read the report.
    for finding in report.get("findings", []):
        rule = finding.get("rule_id")
        title = finding.get("title") or finding.get("message")
        if rule in STALE_SHEXLI:
            print(f"  note  shexli {rule}: {title} (known stale check, ignored)")
            continue
        fail(problems, f"shexli {rule} ({finding.get('severity')}): {title}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("zip")
    parser.add_argument("--shexli", help="path to the shexli executable")
    args = parser.parse_args()

    problems = []
    print(f"Checking {args.zip}")
    archive = check_zip(args.zip, problems)
    if archive:
        check_metadata(archive, problems)
        check_sources(archive, problems)
    run_shexli(args.zip, args.shexli, problems)
    if problems:
        print(f"{len(problems)} problem(s) found")
        return 1
    print("  ok    ready for extensions.gnome.org review")
    return 0


if __name__ == "__main__":
    sys.exit(main())
