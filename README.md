# VERMONT // FALL

*Peak foliage. Stay awhile.*

A living miniature Vermont valley at peak foliage, built with Three.js. You
start high above the valley, looking at an impossibly detailed diorama of
rolling hills, layered ranges fading into haze, a winding two-lane road, a red
covered bridge, a farm, a few white houses and a distant church steeple.

- **Make wind.** Drag across the forest. Your stroke becomes a gust that rolls
  across the hillsides. Canopies lean and settle in sequence, leaves flip their
  pale undersides, a few tear loose, meadow grass flashes, and chimney smoke
  swings round.
- **Enter the road.** Click the tiny mint-green car (or its "Enter the road"
  label). The camera dives out of the sky, down through the canopy, and settles
  just above the hood. Now you are riding through the same valley at an
  unhurried pace: forest canopy, the clearing, the covered bridge (dark, with
  sun slits between the boards, then a bright open valley), the farm, the climb,
  and the overlook. The car slows down so you can take in the view.
- **Look around** by moving or dragging the pointer. Moving it also stirs the
  air around the car, so nearby leaves tumble. Once in a while a leaf lands on
  the windshield, then the airflow peels it away.
- **↑ AERIAL VIEW** (or `Esc`) rises out of the trees and back to the diorama.

Controls: drag = wind (aerial) / look (in the car) · wheel or pinch = subtle
zoom · `H` hide the interface · `M` sound · `Enter` ride along. Sound is off
until you turn it on. Reduced-motion preferences are respected, and there is
also a toggle in the corner.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/
```

Optional URL parameters: `?q=low|medium|high` forces a quality tier.

To check how it runs on a device, add `#debug` to the address or press and
hold the title for a second. A small readout shows the build, quality tier,
GPU, frame rate, draw calls, and whether the grass and ground plants are on.

## How it is built

Everything is procedural and seeded, so the composition is art-directed and
identical on every load. There are no model or texture files.

| Module | What it does |
| --- | --- |
| `world/terrain.ts` | Height function: rolling hills, the knoll the road loops around, the overlook ridge, the brook valley (always downhill), and five layered ranges. The road bed is graded into the land with a grade limit. |
| `world/layout.ts` | The authored composition: road control points, brook, clearings, buildings, lone maples. |
| `world/terrainMesh.ts` | A single warped grid (5 m near, growing to the horizon). Golden-hour hill shadows are baked by marching toward the sun. Distant forest canopy is painted procedurally and filtered to each stand's colour. |
| `world/colors.ts`, `forest.ts` | Peak-foliage art direction: stands that lean golden, maple-orange or crimson, plus evergreen pockets. The mix is roughly 30% orange, 20% gold, 15% crimson, 25% evergreen and 10% yellow-green. |
| `world/treeGeometry.ts`, `trees.ts` | Six species (sugar and red maple, birch, oak/beech, spruce/hemlock, white pine). Far LOD uses lumpy clumps; near LOD adds limbs, twigs, leaf-card crowns and needle boughs. Near trees are refilled around the camera and dither-crossfaded. Shadows come from cheap proxies, and far ranges get single-blob canopy lumps. |
| `world/wind.ts` | Spatial wind field: gust puffs travel across a grid of damped springs (stands of trees), uploaded as a texture that every tree, grass blade and smoke puff samples. |
| `world/leaves.ts` | Pooled falling leaves with glide-and-flutter physics. They react to gusts, the car's wake and the pointer, and include the windshield leaf. |
| `world/bridge.ts` | The covered bridge: board walls with gaps, a Town lattice truss, analytic sun slits, light shafts and eye-adaptation exposure. |
| `world/car.ts`, `world/drive.ts` | The 1950s sedan and its art-directed speed profile around the loop. |
| `camera/*` | Aerial rig (breathing, parallax, limited zoom), POV rig, and the Bézier dive/rise transitions whose control points ride with the car. |
| `render/shared.ts` | Shared uniforms plus a material patcher that adds aerial-perspective haze, cloud shadows and custom vertex/fragment stages to Three's built-in materials. |
| `audio/audio.ts` | Procedural WebAudio ambience. |
| `config.ts` | Quality tiers (resolution, shadow-map size, forest/grass density, particle budgets) and adaptive resolution. |
