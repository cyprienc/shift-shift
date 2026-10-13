"""Prepare reviewed CI artifacts without executing their contents or publishing."""

import argparse
import hashlib
import json
import os
import re
import runpy
import subprocess
from pathlib import Path

REPOSITORY = "cyprienc/shift-shift"
REPOSITORY_ID = 1416853922
OWNERS = {5805228: "cyprienc", 71314309: "jschweiz"}
CI_WORKFLOW_ID = 383096044
CODEQL_WORKFLOW_ID = 383096045
CI_JOBS = {
    "Build and test (ubuntu-24.04)",
    "Build and test (macos-15)",
    "Dependency and workflow security",
    "Attest trusted main artifacts",
}
TARGETS = {"ubuntu-24.04": "linux-x64", "macos-15": "darwin-arm64"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def gh_json(*arguments):
    return json.loads(subprocess.check_output(["gh", *arguments], text=True))


def api(path):
    return gh_json("api", f"repos/{REPOSITORY}/{path}")


def check_environment(environment, policies):
    require(environment.get("can_admins_bypass") is False, "Environment bypass must be disabled")
    require(environment.get("deployment_branch_policy") == {
        "protected_branches": False, "custom_branch_policies": True,
    }, "Environment must use an explicit main-branch policy")
    rules = [r for r in environment["protection_rules"] if r["type"] == "required_reviewers"]
    require(len(rules) == 1 and rules[0].get("prevent_self_review") is True,
            "Environment must prevent self-approval")
    reviewers = {r["reviewer"]["id"] for r in rules[0]["reviewers"] if r["type"] == "User"}
    require(reviewers == set(OWNERS) and len(rules[0]["reviewers"]) == 2,
            "Both named reviewers must be configured; check Jonas's invitation")
    require(policies.get("total_count") == 1 and [
        (p["name"], p["type"]) for p in policies["branch_policies"]
    ] == [("main", "branch")], "Release environment must allow only main")


def check_run(run, workflow_id, path, source):
    require(run.get("workflow_id") == workflow_id and run.get("path") == path,
            "Unexpected workflow")
    require(run.get("event") == "push" and run.get("head_branch") == "main",
            "Only main-branch push builds are release candidates")
    require(run.get("head_sha") == source and run.get("head_repository", {}).get("id") == REPOSITORY_ID,
            "Run does not build the expected repository commit")
    require(run.get("status") == "completed" and run.get("conclusion") == "success",
            "Workflow has not succeeded")
    require(run.get("run_attempt") == 1, "Use a fresh main push; rerun artifacts are not accepted")
    require(run.get("actor", {}).get("id") in OWNERS and
            run.get("triggering_actor", {}).get("id") in OWNERS, "Unexpected build initiator")


def check_jobs(response, expected):
    jobs = response["jobs"]
    require(response["total_count"] == len(expected) and len(jobs) == len(expected),
            "Unexpected or truncated job list")
    require({job["name"] for job in jobs} == expected and all(
        job["status"] == "completed" and job["conclusion"] == "success" for job in jobs
    ), "Required workflow jobs did not all succeed")


def check_review(pull, reviews, source):
    require(pull.get("merged_at") and pull.get("merge_commit_sha") == source,
            "Release commit must be the result of a merged PR")
    require(pull["base"]["ref"] == "main" and pull["base"]["repo"]["id"] == REPOSITORY_ID,
            "Unexpected PR base")
    author = pull["user"]["id"]
    require(author in OWNERS, "Release PR must be authored by a named maintainer")
    require(len(reviews) < 100, "Review list is too large; inspect pagination before release")
    decisions = {}
    for review in sorted(reviews, key=lambda r: r["id"]):
        if review["state"] in {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}:
            decisions[review["user"]["id"]] = review
    for reviewer, review in decisions.items():
        if reviewer in OWNERS and reviewer != author and review["state"] == "APPROVED" and \
                review["commit_id"] == pull["head"]["sha"]:
            return OWNERS[reviewer]
    raise ValueError("Current PR head lacks the other named maintainer's approval")


def check_attestation(results, source, run_id):
    certificate_identity = f"https://github.com/{REPOSITORY}/.github/workflows/ci.yml@refs/heads/main"
    invocation = f"https://github.com/{REPOSITORY}/actions/runs/{run_id}/attempts/1"
    for result in results:
        # Read only after gh cryptographically verifies the bundle. Certificate
        # fields come from GitHub's OIDC issuer; predicate fields alone are untrusted.
        certificate = result["verificationResult"]["signature"]["certificate"]
        expected = {
            "issuer": "https://token.actions.githubusercontent.com",
            "subjectAlternativeName": certificate_identity,
            "sourceRepositoryURI": f"https://github.com/{REPOSITORY}",
            "sourceRepositoryIdentifier": str(REPOSITORY_ID),
            "sourceRepositoryDigest": source,
            "sourceRepositoryRef": "refs/heads/main",
            "buildSignerDigest": source,
            "buildTrigger": "push",
            "runnerEnvironment": "github-hosted",
            "runInvocationURI": invocation,
        }
        if all(certificate.get(key) == value for key, value in expected.items()):
            return
    raise ValueError("No verified provenance certificate matches the expected commit and build run")


def prepare(run_id, source, output):
    require(re.fullmatch(r"[0-9a-f]{40}", source), "Expected a full lowercase commit SHA")
    require(run_id > 0, "Invalid CI run ID")
    require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and
            os.environ.get("GITHUB_REF") == "refs/heads/main" and
            os.environ.get("GITHUB_REPOSITORY") == REPOSITORY and
            os.environ.get("GITHUB_ACTOR_ID") in {str(i) for i in OWNERS} and
            os.environ.get("GITHUB_TRIGGERING_ACTOR") == OWNERS.get(
                int(os.environ.get("GITHUB_ACTOR_ID", "0"))
            ),
            "Release preparation must be dispatched on main by a named maintainer")
    require(source == os.environ.get("GITHUB_SHA") == api("commits/main")["sha"],
            "Release source must equal this workflow's current main commit")
    check_environment(api("environments/release-approval"),
                      api("environments/release-approval/deployment-branch-policies?per_page=100"))
    commit = api(f"commits/{source}")
    require(commit["commit"]["verification"].get("verified") is True,
            "Release commit signature is not verified")
    pulls = api(f"commits/{source}/pulls?per_page=100")
    matching = [p for p in pulls if p.get("merged_at") and p.get("merge_commit_sha") == source]
    require(len(pulls) < 100 and len(matching) == 1, "Expected exactly one merged release PR")
    pull = api(f"pulls/{matching[0]['number']}")
    require(os.environ["GITHUB_ACTOR_ID"] == str(pull["user"]["id"]),
            "The release PR author must initiate preparation so the other owner approves the artifacts")
    reviewer = check_review(pull, api(f"pulls/{pull['number']}/reviews?per_page=100"), source)
    commits = api(f"pulls/{pull['number']}/commits?per_page=100")
    require(0 < len(commits) < 100 and all(
        c["commit"]["verification"].get("verified") is True for c in commits
    ), "Every reviewed PR commit must have a verified signature")

    run = api(f"actions/runs/{run_id}")
    check_run(run, CI_WORKFLOW_ID, ".github/workflows/ci.yml", source)
    check_jobs(api(f"actions/runs/{run_id}/jobs?filter=latest&per_page=100"), CI_JOBS)
    codeql = api(f"actions/workflows/{CODEQL_WORKFLOW_ID}/runs?head_sha={source}&event=push&per_page=100")
    candidates = [r for r in codeql["workflow_runs"] if r.get("conclusion") == "success"]
    require(codeql["total_count"] < 100 and candidates, "No successful main-branch CodeQL run")
    codeql_run = max(candidates, key=lambda r: r["id"])
    check_run(codeql_run, CODEQL_WORKFLOW_ID, ".github/workflows/codeql.yml", source)
    check_jobs(api(f"actions/runs/{codeql_run['id']}/jobs?filter=latest&per_page=100"),
               {"Analyze TypeScript and JavaScript"})

    artifacts = api(f"actions/runs/{run_id}/artifacts?per_page=100")
    require(artifacts["total_count"] == 2 and len(artifacts["artifacts"]) == 2 and {
        a["name"] for a in artifacts["artifacts"]
    } == {f"vsix-{os_name}" for os_name in TARGETS} and all(
        not a["expired"] for a in artifacts["artifacts"]
    ), "Expected both unexpired platform artifacts from the chosen run")
    require(not output.exists(), "Output directory must be new")
    output.mkdir(parents=True)
    package_verifier = runpy.run_path("scripts/verify-package.py")["verify"]
    version = json.loads(Path("package.json").read_text())["version"]
    files = []
    for os_name, target in TARGETS.items():
        directory = output / target
        subprocess.run(["gh", "run", "download", str(run_id), "--repo", REPOSITORY,
                        "--name", f"vsix-{os_name}", "--dir", str(directory)], check=True)
        package = directory / f"shift-shift-cc-{version}-{target}.vsix"
        inventory = directory / "dependencies.cdx.json"
        require(set(directory.iterdir()) == {package, inventory} and all(
            p.is_file() and not p.is_symlink() for p in directory.iterdir()
        ), "Unexpected downloaded artifact files")
        package_verifier(package, target, True)
        for artifact in [package, inventory]:
            results = gh_json("attestation", "verify", str(artifact), "--repo", REPOSITORY,
                              "--signer-workflow", f"{REPOSITORY}/.github/workflows/ci.yml",
                              "--source-ref", "refs/heads/main", "--source-digest", source,
                              "--signer-digest", source, "--deny-self-hosted-runners", "--format", "json")
            check_attestation(results, source, run_id)
            proof = artifact.with_name(artifact.name + ".verification.json")
            proof.write_text(json.dumps(results, indent=2) + "\n")
            files.append({"path": str(artifact.relative_to(output)),
                          "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()})
    manifest = {
        "schema": 1, "repository": REPOSITORY, "source_commit": source,
        "ci_run_id": run_id, "codeql_run_id": codeql_run["id"],
        "release_preparation_run_id": os.environ["GITHUB_RUN_ID"],
        "reviewed_pull_request": pull["number"], "source_reviewer": reviewer,
        "publisher": "CyprienCourtot", "extension": "shift-shift-cc",
        "version": version, "channel": "pre-release", "files": files,
    }
    (output / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    summary = f"## Release candidate {version}\n\nSource: `{source}`\n\n" + \
        f"PR #{pull['number']} approved by `{reviewer}`; CI run `{run_id}`.\n\n" + \
        "| File | SHA-256 |\n| --- | --- |\n" + "".join(
            f"| `{f['path']}` | `{f['sha256']}` |\n" for f in files
        ) + "\nApprove only after independently checking these exact packages and hashes.\n"
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as stream:
        stream.write(summary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ci-run", required=True, type=int)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    prepare(arguments.ci_run, arguments.source, arguments.output)
