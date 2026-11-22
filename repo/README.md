# makefun-site-fast

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/{owner}/{repo}/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/{owner}/{repo}/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own `makefun-site` 1.0.0. `solve.js`'s `run(input)`
returns, for every case's input, exactly the output tree `makefun-site` 1.0.0's
`build()` returns — a JSON object of every path it writes (each page's
`index.html`, the index and tag pages, `build-report.txt` and each static file)
and that file's text, byte for byte.

The front matter, template dialect, Markdown subset, slug rule and report are
`makefun-site`'s own; this entry follows its README and its code wherever the two
differ. The hot paths are optimised: inline Markdown rendering jumps construct to
construct and escapes plain runs in bulk, slugify skips Unicode normalisation for
ASCII, and each template is compiled once to a straight-line render function
instead of being walked as a node tree. Output is byte-for-byte identical to the
reference on every case.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json`, answers each with `run` from
`solve.js`, and writes `/output/answers.json`. Outside a container,
`MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

---

<sub>Entered on [make.fun](https://make.fun/?ref={referral_code}&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>