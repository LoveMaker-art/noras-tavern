# Local iframe runtime dependencies

These files remove the network dependency from the TavernHelper message iframe
used by Nora's complex-card runtime.

- `vue.runtime.global.prod.min.js`: Vue `3.5.41`, MIT.
- `vue-router.global.prod.min.js`: Vue Router `5.2.0`, MIT.
- `log.js`: JS-Slash-Runner `4.9.3`, commit
  `9403f47774962792ae6ac8c08ad9740a723ea872`, MIT.
- `jquery-3.5.1.min.js`: jQuery `3.5.1`, MIT.
- `jquery-ui/jquery-ui-1.13.2.min.js`, stylesheet and images: jQuery UI
  `1.13.2`, MIT.
- `jquery-ui-touch-punch-1.0.9.min.js`: RWAP jQuery UI Touch Punch
  `1.0.9`, MIT or GPL Version 2. The license notice is embedded in the file.
- `fontawesome`: Font Awesome Free `6.5.2`, supplied under its bundled
  licenses in `fontawesome/LICENSE.txt`.

Only fixed framework-owned iframe bootstrap URLs in `dist/index.js` are
redirected to these local files. Character-authored URLs, media and API calls
are left unchanged.
