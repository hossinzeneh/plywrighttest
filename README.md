# EAMENA PDF visual test

```bash
npm install
npx playwright install chromium
npx playwright test --update-snapshots
npx playwright test
npx playwright test --headed
npx playwright show-report
```

The first run writes the baseline with `--update-snapshots`. Later runs compare and do not update it. `--headed` shows the browser.

Playwright opens the page only to find and download the PDF. The picture is of the saved file after it is rendered. The site header is not in the picture. On failure, npx playwright show-report shows the baseline, the new picture, and the diff. The baseline is for this OS and this browser.

This test screenshots the saved file because that is the downloaded document, not the embedded frame. The site header is outside the canvas, so it cannot change the picture. A layout change in the PDF still fails the pixel comparison.
