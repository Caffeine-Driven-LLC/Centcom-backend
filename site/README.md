# Centcom site: sales page and documentation

Static, dependency-free. Built by Caffeine Driven LLC for Centcom.

```
site/
  src/        page templates (index.html = sales page, docs.html = documentation, _nav/_footer partials)
  public/     everything served as-is: css, js, fonts (SIL OFL), Cento animation data, images
  data/       commands.json, models.json, status.json (generated from the client repo)
  tools/      refresh-data.sh
  build.py    renders src + data into dist/
```

## Build and preview

```bash
python3 site/build.py                       # writes site/dist
python3 -m http.server -d site/dist 8080    # open http://localhost:8080
```

No Node, no bundler. `dist/` is git-ignored; deploy it on any static host (Cloudflare Pages, Vercel, Netlify, GitHub Pages). Point the host's build command at `python3 site/build.py` and the output directory at `site/dist`. `404.html` is generated.

## Keeping it true

The docs tables (slash commands, models) and the "next steps" and progress bar come from the client repo, so they cannot drift from the product:

```bash
site/tools/refresh-data.sh ../Centcom       # then: python3 site/build.py
```

Rules for editing copy: every feature is tagged **Available now** or **Planned**, never both blurred; no prices, customers, quotes or statistics that do not exist; keep the trademark and "not affiliated" notices in the footer.

## Credits

Built by **Caffeine Driven LLC**. GitHub: [Caffeine-Driven-LLC](https://github.com/Caffeine-Driven-LLC). Lead developer: Alexander Gese, [@AlexanderGese](https://github.com/AlexanderGese). Fonts: Instrument Sans, JetBrains Mono (SIL Open Font License, licenses in `public/fonts`). Cento and the Graphite/Paper design system come from the client repo's `assets/`.
