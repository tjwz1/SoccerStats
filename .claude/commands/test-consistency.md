Run consistency tests: verifies that the same feature behaves identically across different entry points (e.g. both search surfaces return the same results, team selection preserved when switching tabs, all tabs show correct breadcrumb).

```bash
cd e2e && python -m pytest -m consistency -v
```
