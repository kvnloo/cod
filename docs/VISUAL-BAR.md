# The Visual Bar

The reference is a shipped modern Call of Duty (Modern Warfare II/III, Black Ops
6) running at 1080p+ on high settings. This document is the rubric critics score
against. It is deliberately concrete — "looks good" is not a review.

Most WebGL work fails on the same handful of tells. If you fix only these, you
close 80% of the gap.

## The seven tells that scream "hobby project"

1. **Flat, uniform surfaces.** Real materials have colour variation over metres,
   grime concentrated in crevices and at the base of walls, edge wear where things
   get touched, and normal detail at two scales (macro form + micro grain). A
   wall that is one colour with one normal map is instantly recognisable as fake.
2. **Missing ambient occlusion.** Every place two surfaces meet must darken. Where
   a crate sits on the floor, where a pipe meets a wall, in every corner, under
   every lip. Without contact darkening, objects look pasted on rather than
   *placed in* the scene.
3. **No highlight rolloff.** Naive rendering clips bright pixels to flat white.
   Film and shipped games roll highlights off over 2–3 stops with a slight hue
   shift toward the light's colour. If the sky or a light source is a flat white
   blob with a hard edge, the tonemapper is wrong.
4. **Uniform, shadowless lighting.** Real scenes have a dominant key, a distinctly
   different-coloured fill (sky bounce is blue; interior bounce takes the colour
   of the floor), and deep but not black shadows. Ambient that lights every face
   equally is the single flattest-looking mistake.
5. **Empty, unlayered composition.** A AAA sightline always has something in the
   near foreground (a wire, a railing, a wall edge), a midground subject, and a
   background with atmospheric depth. Straight unbroken lines and repeated
   identical props read as a level editor.
6. **No atmosphere.** Distance must desaturate and lift toward the sky colour.
   Air is not transparent over 80 metres. Light shafts, dust motes and haze are
   what make a scene feel like a place with air in it.
7. **Wrong scale and proportion.** Doors 2.1m, ceilings 2.7–3.2m, cars 1.5m tall,
   kerbs 15cm, stair risers 17cm. If a crate is the same size as a doorway, the
   whole scene reads as toy-like.

## Per-domain criteria

### Lighting and exposure
- One dominant directional key with a clear direction readable from every shadow.
- Sky fill visibly cooler than the key; bounce light picks up the colour of the
  surface it bounced from.
- Shadows are coloured (blue-ish outdoors), not black, and have contact hardening:
  sharp where the occluder touches, softening with distance.
- Exposure is anchored to the subject, not the sky. Interiors seen from outside
  read as dark; stepping inside, the eye (auto-exposure) adapts over ~1s.
- No clipped channels except in the sun disc and direct emissives.

### Materials
- At 1m, a surface still shows detail — no mush, no obvious tiling.
- Roughness varies across a surface. Uniform roughness is the fake tell.
- Metals have no diffuse and take their colour from the environment; a metal that
  looks grey in a colourful scene is wrong.
- Edges catch light: chamfers and worn edges are brighter/less rough.
- Dirt accumulates by gravity and cavity, never uniformly.

### Geometry
- No unchamfered 90° edges on hero objects — real edges catch a highlight.
- Silhouette complexity: props read at distance by their outline.
- Repeated props are rotated, scaled, tinted and damaged differently.
- No z-fighting, no visible seams, no floating objects, correct contact.

### Post-processing
- Bloom only where something is genuinely brighter than white; it must not fog
  the whole image. Wide, soft, and low-amplitude beats tight and bright.
- Motion blur present but subtle enough to read the scene while turning.
- Depth of field only when aiming, and only enough to separate the weapon from
  the world.
- Grain fine and mostly in the shadows; visible grain in bright areas is wrong.
- Chromatic aberration only at the frame edge, at fractions of a pixel.
- Sharpening must not produce halos around high-contrast edges.

### Weapons and first-person
- The weapon occupies roughly the lower-right third, correctly proportioned to
  hands, with the sight line landing on screen centre when aimed.
- Constant subtle motion: breathing, sway, bob. A static weapon looks dead.
- Recoil moves the weapon *and* the camera, by different amounts, and recovers on
  a spring rather than a linear ramp.
- The weapon is lit by the world — a muzzle flash must light the barrel and hands.

### Characters
- Silhouette reads as a person at 50m: shoulders, helmet, kit break-up.
- Gear layers cast shadows on the body underneath.
- Feet plant on the ground; no sliding, no floating, no ice-skating.
- Heads track what they look at; bodies lead turns.

### Effects
- Smoke and dust are *lit*: brighter facing the key, darker away from it.
- Particles fade softly where they intersect geometry (soft particles), never
  showing a hard cut line.
- Explosions have a sequence — flash, expansion, dust wave, settling smoke — not
  a single sprite pop.
- Sparks are physical: they arc, bounce and die out.

### HUD
- Nothing is pure white or pure black; nothing uses a default browser font look.
- Every element enters and exits with a spring, never a linear fade.
- Information hierarchy: ammo and health readable in peripheral vision; everything
  else recedes.
- Hairlines stay 1px at every resolution.

## How to score

For each shot, answer:
1. Which of the seven tells are present? (each present tell = automatic fail)
2. If this were posted next to a real CoD screenshot with no labels, which would
   a stranger pick as the real game, and *what specifically* gave it away?
3. What is the single highest-impact change?

A pass means: no tells present, and the blind-comparison answer is "I would have
to look closely." Anything else is a fail with specific, actionable notes.
