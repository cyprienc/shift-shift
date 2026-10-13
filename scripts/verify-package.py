"""Inspect the final VSIX without extracting files or executing package code."""

import argparse
import hashlib
import json
import platform
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile


def verify(package: Path, target: str, pre_release: bool) -> None:
    source_manifest = json.loads(Path("package.json").read_text())
    namespace = {"vsix": "http://schemas.microsoft.com/developer/vsx-schema/2011"}
    with ZipFile(package) as archive:
        worker_path = f"extension/bin/{target}/shift-shift-worker"
        expected_files = {
            "extension.vsixmanifest",
            "[Content_Types].xml",
            "extension/package.json",
            "extension/readme.md",
            "extension/changelog.md",
            "extension/LICENSE.txt",
            "extension/SECURITY.md",
            "extension/THIRD_PARTY_NOTICES.md",
            "extension/dist/extension.js",
            "extension/bin/checksums.json",
            worker_path,
        }
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != expected_files:
            raise ValueError(f"Unexpected package contents: {names}")

        manifest = json.loads(archive.read("extension/package.json"))
        if manifest != source_manifest:
            raise ValueError("Packaged extension manifest differs from source")
        vsix = ET.fromstring(archive.read("extension.vsixmanifest"))
        identity = vsix.find("vsix:Metadata/vsix:Identity", namespace)
        expected_identity = {
            "Id": source_manifest["name"],
            "Publisher": source_manifest["publisher"],
            "Version": source_manifest["version"],
            "TargetPlatform": target,
        }
        if identity is None or any(
            identity.get(key) != value for key, value in expected_identity.items()
        ):
            raise ValueError("Unexpected VSIX identity")
        release_flags = [
            prop.get("Value")
            for prop in vsix.findall("vsix:Metadata/vsix:Properties/vsix:Property", namespace)
            if prop.get("Id") == "Microsoft.VisualStudio.Code.PreRelease"
        ]
        if release_flags != (["true"] if pre_release else []):
            raise ValueError(f"Unexpected pre-release metadata: {release_flags}")
        checksums = json.loads(archive.read("extension/bin/checksums.json"))
        if checksums.get(target) != hashlib.sha256(archive.read(worker_path)).hexdigest():
            raise ValueError("Bundled worker checksum mismatch")
    print(f"Verified {package.name}: publisher, version, platform, release channel, contents and worker digest")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pre-release", action="store_true")
    parser.add_argument("--target", choices=["darwin-arm64", "linux-x64", "linux-arm64"])
    args = parser.parse_args()
    target = args.target
    if target is None:
        operating_system = {"darwin": "darwin", "linux": "linux"}.get(sys.platform)
        architecture = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64"}.get(
            platform.machine().lower()
        )
        target = f"{operating_system}-{architecture}"
    if target not in {"darwin-arm64", "linux-x64", "linux-arm64"}:
        parser.error("Specify a supported --target")
    version = json.loads(Path("package.json").read_text())["version"]
    verify(Path(f"artifacts/shift-shift-{version}-{target}.vsix"), target, args.pre_release)
