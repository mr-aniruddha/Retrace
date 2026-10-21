# Retrace — charts in, data out

Retrace turns a chart image (or a whole PDF) back into data. It reads the axes, finds every series, rebuilds the chart from the numbers, shows you how well the rebuild matches, and gives you an Excel file with a real, editable Excel chart.

Everything runs in the browser. Nothing is uploaded, there is no server, no account and no API key.

## Put it on GitHub Pages

1. Create a repository (for example `retrace`) and upload **the contents of this folder** to it, keeping the structure (`index.html` at the top, plus `css/`, `js/`, `vendor/`, `samples/`, `.nojekyll`).
2. In the repository: **Settings → Pages → Build and deployment → Deploy from a branch**, pick `main` and `/ (root)`, save.
3. After a minute the site is live at `https://<your-user>.github.io/retrace/`.

The GitHub link in the header points at the repository automatically.

To try it locally, serve the folder with any static server (for example `python3 -m http.server`) and open `http://localhost:8000`. Opening `index.html` straight from disk will not work, because browsers block the OCR worker on `file://` pages.

## What it handles

- Lines, steps, areas, bands (shaded ranges), scatter, vertical and horizontal bars (grouped and stacked), pie and doughnut charts
- One or two value axes, linear or log scales
- Numbers, percentages, years, two-digit years (`82 … 10`), months (`Mar-01`), quarters and fiscal years (`FY12`), including labels rotated 90°
- Legends matched to colours; series without a legend become A, B, C
- Printed values on bars are used as ground truth when they agree with the bar geometry
- PDFs: every chart on every page, one sheet each, plus a contents sheet

## How it works

| Step | What happens |
|---|---|
| Text | Character-sized shapes are grouped into words and read one at a time by Tesseract (bundled in `vendor/`, works offline after the first visit). Rotated axis labels are turned upright and read as a strip. Dropped decimal points are restored from the glyph layout. |
| Axes | Tick labels are fitted with a robust line (outliers from misreads are ignored). Two-digit years are unwrapped across the century. |
| Colours | Pixels in the plot are clustered by colour; anti-aliased fringes, JPEG halos and line crossings are folded back into the colour they belong to. Gridlines, axes and tick marks are removed. Shaded background panels are treated as background. |
| Series | Each colour is classified as line, step, area, band, bar or scatter and traced column by column, out from a clean middle seed, keeping peaks. |
| Rebuild | The chart is redrawn from the values alone, at the original size, and laid over the original. |
| Scores | **Trace match**: how many rebuilt pixels land on the original series and vice versa (within 2 px). **Axis fit**: how well all tick labels sit on one scale. **Printed values**: agreement with numbers printed on the chart. A confidence ribbon marks the stretches worth checking. |
| Excel | Data is resampled to the coarsest calendar grid (annual, quarterly, monthly, weekly, daily) that redraws every series within about a pixel; otherwise one row per pixel. The chart is written as native Excel chart XML with the source's colours, line widths, dashes, axis ranges, tick spacing, gridlines, title and legend placement. The original image is placed beside it. |

## Limits worth knowing

- Accuracy is bounded by the image: about one pixel. On a typical 500-pixel-wide chart that is roughly 0.2–0.5% of the axis range.
- Lines that run on top of each other for long stretches are interpolated where hidden; the confidence ribbon shows where.
- Heavily decorated infographics (shaded panels, callout boxes, multi-coloured single series) may need a manual check.
- 3-D charts are not supported: perspective makes the values unrecoverable.

## Licence

MIT. Bundled libraries keep their own licences: Tesseract.js (Apache-2.0), PDF.js (Apache-2.0), JSZip (MIT/GPLv3).
