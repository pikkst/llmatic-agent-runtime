# Auto Review Agent smoke test

This temporary document exists only to exercise the repository-bound Auto Review Agent against a real open pull request.

Expected behavior:

- detect this pull request without changing Jira or task ownership;
- run the configured external review lenses;
- surface review progress and completion state in Runtime Status;
- preserve the reviewed pull-request head SHA;
- keep publication manual unless explicitly confirmed.

This pull request is not intended for merge. Close it after the smoke test is complete.
