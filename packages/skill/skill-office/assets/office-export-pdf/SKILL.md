---
name: office-export-pdf
description: Convert an Office or legacy WPS document to a requested PDF.
---

# Export an Office document to PDF

When the supplied runtime includes `officeConvert`, use it for every conversion. It prefers a headless system WPS and falls back to the bundled LibreOffice Kit. Otherwise use the absolute Node and CLI paths supplied below. Prefer bundled LibreOffice unless the user requests another installation. If the Office sidecar is missing, follow [sidecar setup](../office/references/sidecar.md): ask whether the user wants to download it and install only after they agree. Do not invoke system soffice, use npx, or install a replacement to work around a failed conversion with an installed sidecar.

Convert the final saved Office file to a new PDF in the task workspace. Preserve the source. Quote each input and output path.

```text
"<officeConvert>" --input <final-office-file> --output <new-file.pdf>
"<node>" "<cli>" convert --input <final-office-file> --output <new-file.pdf>
```

Check the command result, nonempty output, and `%PDF-` file signature, then report that extent of validation. Unless the user requests deeper checks, do not search for PDF readers, generate images, or install tools to validate a conversion. Spreadsheet PDF pages follow workbook print settings; change those settings only when requested. Conversion may differ from the native application's pagination or fonts.

If export fails, preserve the usable source and report the export limitation. Do not repeatedly convert an unchanged source or use conversion to investigate a failed preview. For PDF export alone, stop after these checks. Only a request for images or visual inspection calls for `office-render`; load it before that separate operation. Deliver the requested PDF through `present` when available, keeping the file in place.
