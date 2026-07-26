Run search tests: sidebar team search (2-char minimum, debounce, results, selection, no-results), mobile header search (icon, autofocus, dropdown, close, selection), consistency between the two surfaces, and edge cases.

```bash
cd e2e && python -m pytest -m search -v
```
