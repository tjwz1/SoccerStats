Run schedule view tests: match card list, finished vs upcoming, competition badge, position chart, and the match detail panel (Lineup / Stats / Timeline / H2H tabs).

```bash
cd e2e && python -m pytest -m "schedule or match_detail" -v
```
