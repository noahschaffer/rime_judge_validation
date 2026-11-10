# judge validation

A static page for checking an LLM judge's verdicts by hand. It draws a sample from the judge's results
(`assets/musiccaps_prompt_report.jsonl`) and shows one example at a time: the edit graph as a diagram,
the caption, the three prompt variants (AL0, AL1, AL2) and the judge's verdicts on `al_rules`,
`al_consistency` and `stylistic`. For each criterion you record your own pass/fail verdict and a
justification, then download the results as JSONL.

Live: https://noahschaffer.github.io/rime_judge_validation/

## Usage

Serve the folder and open http://localhost:8000:

```bash
python3 -m http.server 8000
```

Opening `index.html` straight from disk works too, but the browser won't let the page read the data
file on its own, so it asks you to choose it.

- <kbd>←</kbd> and <kbd>→</kbd> move between examples. The strip under the header shows which examples
  are done and jumps to any of them.
- Verdicts are saved in the browser as you go. Progress is kept per address, so the live site and
  localhost each keep their own.
- **Hide judge until I answer** keeps each judge verdict hidden until you have chosen yours.
- **Sample** picks how the sample is drawn. *Random* takes 100 rows uniformly. *Stratified* groups rows
  by the judge's three verdicts and gives each combination an equal share, so cases the judge failed
  are well represented. The ⓘ button next to it shows how the sample compares with the whole file.
- **New sample** draws a different sample. The URL carries the seed (and `sampling=stratified`), so
  sharing it gives someone else the same examples.
- **Open file…** loads another JSONL, or a results file you downloaded earlier to keep working on it.

URL parameters: `seed`, `sampling=stratified`, `n` (sample size, default 100) and `data` (path to a
different JSONL, plain or gzipped).

## Results file

**Download results** saves one line per sampled example: the source line exactly as it was, with these
fields appended.

| Field | Value |
| --- | --- |
| `user_al_rules`, `user_al_consistency`, `user_stylistic` | `"pass"` or `"fail"`, or `null` if not answered |
| `user_al_rules_justification`, `user_al_consistency_justification`, `user_stylistic_justification` | your text, `""` if none |

Rows from a stratified sample also get `sample_stratum` (the judge's verdict combination, such as
`al_rules=fail|al_consistency=pass|stylistic=appropriate`) and `sample_weight` (rows in that combination
÷ rows drawn from it). Weight by `sample_weight` to estimate rates for the whole file; unweighted
counts overstate the rare combinations.

## Publishing on GitHub Pages

GitHub Pages serves this repository's `main` branch as it is. The raw JSONL is not committed (see
`.gitignore`). Instead the site ships `assets/musiccaps_prompt_report.jsonl.gz` (11 MB instead of
55 MB), which the page unpacks in the browser. The page loads the raw file when it exists, as it does
locally, and falls back to the `.gz` copy. After changing the data, rebuild the copy, then commit and
push:

```bash
gzip -9 -n -c assets/musiccaps_prompt_report.jsonl > assets/musiccaps_prompt_report.jsonl.gz
```

The site is public: anyone with the link can open the page and download the data.

One-time setup, already done: the repository `noahschaffer/rime_judge_validation` is public, and
Settings → Pages is set to "Deploy from a branch", branch `main`, folder `/ (root)`.
