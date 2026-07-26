Run URL navigation tests: direct links to /competitions/:code and /competitions/:code/teams/:id, sidebar navigation updating the address bar, breadcrumb clicks syncing URL, browser back through history, cold reload restoring team view, and invalid IDs not crashing the app.

```bash
cd e2e && python -m pytest -m url_nav -v
```
