"""Regression probes for release metadata; no artifacts are executed."""

import copy
import os
import runpy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

policy = runpy.run_path("scripts/prepare-release.py")
SOURCE = "a" * 40


class ReleasePolicy(unittest.TestCase):
    def test_build_must_be_original_successful_main_push(self):
        run = {
            "workflow_id": policy["CI_WORKFLOW_ID"], "path": ".github/workflows/ci.yml",
            "event": "push", "head_branch": "main", "head_sha": SOURCE,
            "head_repository": {"id": policy["REPOSITORY_ID"]},
            "status": "completed", "conclusion": "success", "run_attempt": 1,
            "actor": {"id": 5805228}, "triggering_actor": {"id": 71314309},
        }
        check = lambda r: policy["check_run"](r, policy["CI_WORKFLOW_ID"], ".github/workflows/ci.yml", SOURCE)
        check(run)
        for key, value in [
            ("event", "pull_request"), ("head_branch", "attack"), ("head_sha", "b" * 40),
            ("workflow_id", 1), ("path", ".github/workflows/attack.yml"),
            ("run_attempt", 2), ("conclusion", "failure"),
            ("head_repository", {"id": 1}), ("actor", {"id": 1}),
        ]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                check({**run, key: value})

    def test_review_must_be_independent_named_and_current(self):
        pull = {
            "merged_at": "2026-10-13T12:00:00Z", "merge_commit_sha": SOURCE,
            "base": {"ref": "main", "repo": {"id": policy["REPOSITORY_ID"]}},
            "user": {"id": 5805228}, "head": {"sha": "c" * 40},
        }
        review = {"id": 1, "user": {"id": 71314309}, "state": "APPROVED", "commit_id": "c" * 40}
        check = lambda reviews: policy["check_review"](pull, reviews, SOURCE)
        self.assertEqual(check([review]), "jschweiz")
        for changed in [
            {**review, "user": {"id": 5805228}}, {**review, "user": {"id": 1}},
            {**review, "commit_id": "d" * 40}, {**review, "state": "CHANGES_REQUESTED"},
        ]:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                check([changed])
        with self.assertRaises(ValueError):
            check([review, {**review, "id": 2, "state": "DISMISSED"}])
        with self.assertRaises(ValueError):
            policy["check_review"]({**pull, "merged_at": None}, [review], SOURCE)
        with self.assertRaises(ValueError):
            check([review] * 100)

    def test_environment_requires_both_reviewers_no_self_review_or_bypass(self):
        environment = {
            "can_admins_bypass": False,
            "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True},
            "protection_rules": [{"type": "required_reviewers", "prevent_self_review": True,
                                  "reviewers": [{"type": "User", "reviewer": {"id": i}}
                                                for i in policy["OWNERS"]]}],
        }
        branches = {"total_count": 1, "branch_policies": [{"name": "main", "type": "branch"}]}
        check = lambda e, b=branches: policy["check_environment"](e, b)
        check(environment)
        for change in ["bypass", "self", "missing-reviewer", "extra-reviewer"]:
            altered = copy.deepcopy(environment)
            if change == "bypass": altered["can_admins_bypass"] = True
            if change == "self": altered["protection_rules"][0]["prevent_self_review"] = False
            if change == "missing-reviewer": altered["protection_rules"][0]["reviewers"].pop()
            if change == "extra-reviewer":
                altered["protection_rules"][0]["reviewers"].append({"type": "User", "reviewer": {"id": 1}})
            with self.subTest(change=change), self.assertRaises(ValueError): check(altered)
        with self.assertRaises(ValueError):
            check(environment, {"total_count": 1, "branch_policies": [{"name": "*", "type": "branch"}]})

    def test_provenance_checks_issuer_bound_certificate_not_only_predicate(self):
        repo = policy["REPOSITORY"]
        certificate = {
            "issuer": "https://token.actions.githubusercontent.com",
            "subjectAlternativeName": f"https://github.com/{repo}/.github/workflows/ci.yml@refs/heads/main",
            "sourceRepositoryURI": f"https://github.com/{repo}",
            "sourceRepositoryIdentifier": str(policy["REPOSITORY_ID"]),
            "sourceRepositoryDigest": SOURCE, "sourceRepositoryRef": "refs/heads/main",
            "buildSignerDigest": SOURCE, "buildTrigger": "push", "runnerEnvironment": "github-hosted",
            "runInvocationURI": f"https://github.com/{repo}/actions/runs/123/attempts/1",
        }
        wrap = lambda c: [{"verificationResult": {"signature": {"certificate": c}}}]
        check = lambda c: policy["check_attestation"](wrap(c), SOURCE, 123)
        check(certificate)
        for key in certificate:
            with self.subTest(key=key), self.assertRaises(ValueError):
                check({**certificate, key: "forged"})
        with self.assertRaises(ValueError): policy["check_attestation"]([], SOURCE, 123)

    def test_missing_failed_or_duplicate_checks_do_not_pass(self):
        jobs = [{"name": name, "status": "completed", "conclusion": "success"}
                for name in policy["CI_JOBS"]]
        check = lambda values: policy["check_jobs"]({"total_count": len(values), "jobs": values}, policy["CI_JOBS"])
        check(jobs)
        for changed in [jobs[:-1], jobs + [jobs[0]], [{**j, "conclusion": "skipped"} for j in jobs]]:
            with self.assertRaises(ValueError): check(changed)

    def test_preparation_never_downloads_without_independently_reviewed_source(self):
        environment = {
            "can_admins_bypass": False,
            "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True},
            "protection_rules": [{"type": "required_reviewers", "prevent_self_review": True,
                                  "reviewers": [{"type": "User", "reviewer": {"id": i}}
                                                for i in policy["OWNERS"]]}],
        }
        responses = {
            "commits/main": {"sha": SOURCE},
            "environments/release-approval": environment,
            "environments/release-approval/deployment-branch-policies?per_page=100": {
                "total_count": 1, "branch_policies": [{"name": "main", "type": "branch"}],
            },
            f"commits/{SOURCE}": {"commit": {"verification": {"verified": True}}},
            f"commits/{SOURCE}/pulls?per_page=100": [],
        }
        runtime = {
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/main",
            "GITHUB_REPOSITORY": policy["REPOSITORY"], "GITHUB_ACTOR_ID": "5805228",
            "GITHUB_TRIGGERING_ACTOR": "cyprienc", "GITHUB_SHA": SOURCE,
        }
        prepare = policy["prepare"]
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, runtime), \
                patch.dict(prepare.__globals__, {"api": lambda path: responses[path]}), \
                patch("subprocess.run") as download:
            with self.assertRaisesRegex(ValueError, "exactly one merged"):
                prepare(123, SOURCE, Path(directory) / "candidate")
            download.assert_not_called()
            self.assertFalse((Path(directory) / "candidate").exists())
            responses["environments/release-approval"]["protection_rules"][0]["reviewers"].pop()
            with self.assertRaisesRegex(ValueError, "Both named reviewers"):
                prepare(123, SOURCE, Path(directory) / "candidate")
            download.assert_not_called()
            for key, value in [("GITHUB_EVENT_NAME", "pull_request"),
                               ("GITHUB_REF", "refs/heads/attack"),
                               ("GITHUB_ACTOR_ID", "1"),
                               ("GITHUB_TRIGGERING_ACTOR", "jschweiz")]:
                with self.subTest(key=key), patch.dict(os.environ, {key: value}), \
                        self.assertRaisesRegex(ValueError, "dispatched on main"):
                    prepare(123, SOURCE, Path(directory) / "candidate")
            download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
