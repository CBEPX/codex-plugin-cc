### Task 10: Release v1.4.0

- [ ] `node scripts/bump-version.mjs 1.4.0 && npm run check-version && npm run check:changelog`.
- [ ] Полный `npm run check` + leak-check + `claude plugin validate . --strict` + `npm audit --omit=dev` + `npm pack --dry-run`.
- [ ] Claude whole-branch review; `/codex:adversarial-review --base main --effort max` с фокусом на Task 5 (spawn) и Task 6 (stdin) — DO-NOT-SHIP блокирует.
- [ ] По команде пользователя: push, PR → зелёная матрица с обязательным Windows → `gh pr merge --merge` → tag → `npm pack` + sha256 → `gh release create` (`docs/RELEASING.md`) → `claude plugin update codex@cbepx`.
- [ ] Черновик `docs/superpowers/triage/upstream-comments-v1.4.0.md` → одобрение → `gh issue comment`; статусы в триаж-документе → `fixed-in v1.4.0`.

## Self-review

- Spec coverage: пункты 1–6 раздела v1.4.0 спека → Task 1–2 (п.1–2), Task 3 (п.3), Task 4–7 (п.4), Task 8 (п.5), Task 9–10 (п.6). v1.4.1 (identity) намеренно вне плана.
- Placeholder scan: пороги c8 «факт-2» и mutation score определяются измерением в Task 3 и записываются в отчёт — это не TBD, а правило.
- Type consistency: `readHookInput` → `{input, truncated, timedOut}` в обоих хуках; `resolveExecutable`/`spawnOptionsFor` используются и в `runCommand`, и в `app-server.mjs`.
- Review Focus 1–5 → Task 4, 5, 6, 1, 2 соответственно.
