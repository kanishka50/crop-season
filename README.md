# Crop Season

An augmented reality tool for teaching crop spacing and crop care to farmers and extension
trainees.

Spacing is taught as a number. Twenty five centimetres means very little written on a page or
said out loud. This puts a planting bed on the ground in front of you, at real size, and lets you
tend it for a season to see what that spacing actually costs and returns.

Built for INTE 42312, Virtual and Augmented Reality.

**Live site:** _to be added once deployed._

## The two modes

| Mode | What it does | Needs |
|---|---|---|
| **Scan a seed packet** | Point the camera at a printed card. The crop appears above it with its spacing. | Any phone with a camera, over `https://` |
| **Plan your plot** | Place a 1.2 m planting bed on a real floor, water and feed it through a five week season, then harvest it and read the score. | Android Chrome, on an ARCore certified phone |

The second mode uses WebXR, which no browser on iOS supports. Every iOS browser is built on
WebKit, so installing Chrome on an iPhone does not change this. The landing page checks the
device and says plainly which of the two modes will work before you pick one.

Verified on a Samsung Galaxy M31 (both modes) and an iPhone (scan mode only).

## Before you start

Print `targets/marker-b.png`, the pineapple card. Marker mode tracks that card and nothing else.
The landing page links to it, so it can be opened and printed straight from the live site.

Print it on paper. Holding a phone or a monitor up to the camera adds glare and tracks worse.

There is one card, not two. A paddy card was tried and dropped: the paddy model read badly
standing on a card, and paddy is already the crop the whole markerless field is made of. So each
mode now shows a different crop.

## Running it locally

The camera only works on a secure page, which means `https://` or `localhost`. A local network
address like `http://192.168.1.5` will never get the camera, however convenient it looks.

Serve the folder:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000` on the same machine. To test on a phone, put an HTTPS tunnel in
front of it in a second terminal:

```bash
ngrok http 8000
```

and open the `https://` address it prints. Do not open `index.html` by double clicking it. A
`file://` page cannot get the camera.

## What is in here

```
index.html        landing page, mode select, device capability check
marker.html       marker tracking, MindAR image targets
markerless.html   markerless tracking, WebXR hit-test and anchors
css/style.css
js/crops.js       crop data, bed layout, tool sizes, the season rules
js/planner.js     the markerless experience: placement, dragging, season, harvest, score
audio/            five synthesised feedback sounds
models/           five optimised glTF models
targets/          the two printable cards and the compiled targets.mind
vendor/           A-Frame and its font, served locally
```

`js/crops.js` holds every tuning number in one place, including the season rules themselves, so
the rules sit next to the numbers they act on and can be run without a browser.

## How it is built

Static site. No build step, no bundler, no package to install.

| Page | Framework | Version |
|---|---|---|
| `marker.html` | A-Frame + MindAR | 1.5.0 and 1.2.5, from their CDNs |
| `markerless.html` | A-Frame | 1.8.0, served from `vendor/` |

Markerless mode serves A-Frame from this repository rather than a CDN, and the Roboto font atlas
with it. That is deliberate. It means the whole markerless experience runs with the internet
switched off after one load, which has been tested in airplane mode on the M31.

## Rebuilding the marker card

The cards are generated rather than drawn, so they can be regenerated at any time with
`python tools/make_markers.py`. They are designed for tracking rather than for looks: an
asymmetric layout so a card cannot lock in two orientations, a scattered rather than gridded
arrangement, type at several sizes so features survive at several distances, and no large flat
areas where tracking would drop.

After regenerating, compile `marker-b.png` into `targets.mind` with the
[MindAR compiler](https://hiukim.github.io/mind-ar-js-doc/tools/compile), which runs in the
browser, and save the result over `targets/targets.mind`.

**A target's index is its position in that file, not its name.** With one image compiled, the
pineapple is `targetIndex: 0`. If a second card is ever added, the order it goes into the
compiler decides the indexes, and `CARD_CROP_IDS` at the top of `marker.html`'s script has to
list the crops in that same order. That list is what stops one crop's spacing figure appearing
under another crop's picture.

## Attributions

Third party models, libraries and fonts are credited in [ATTRIBUTIONS.md](ATTRIBUTIONS.md).

The watering can is CC BY 4.0, so crediting its author is a licence condition rather than a
courtesy. The other four models are CC0. The sounds and both marker cards are original work.
