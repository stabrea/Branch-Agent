# datefmt changelog

## 2.0.0 (breaking)

- `format(pattern, date)` is removed. Use `formatDate(date, pattern)` — note the arguments are the other way round.
- Pattern tokens are now upper case: `yyyy` is `YYYY`, `mm` is `MM`, `dd` is `DD`.

## 1.4.0

- `format(pattern, date)` with tokens `yyyy`, `mm`, `dd`.
