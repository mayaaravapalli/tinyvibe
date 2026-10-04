// Hand-authored composition of the valley. x = east, z = south (towards the
// aerial camera). Everything is in metres.

export type V2 = [number, number]

/** The loop road, driven clockwise (seen from above with north up). */
export const ROAD_POINTS: V2[] = [
  [-140, 382], // A  close forest
  [-40, 438], //     bulging towards the camera
  [78, 402], // B  clearing with the first white house
  [150, 334], //
  [192, 270], // C  descending to the brook
  [228, 216], // D  straight run onto the covered bridge
  [262, 168], //    bridge centre
  [296, 120], // E  out into the bright valley
  [352, 76], // F  meadow
  [424, 62], //
  [484, 16], // G  the farm
  [506, -66], // H
  [474, -154], //    S-bend climbing out of the farm
  [512, -262], // I
  [566, -356], // J  hillside, views opening
  [522, -452], //    hairpin
  [418, -486], // K
  [300, -540], // L  overlook approach, climbing north-north-west into the view
  [238, -632], //    the crest: the valley opens straight ahead
  [130, -684], //    pull-off, turning west along the ridge
  [8, -652], // M
  [-96, -598], //
  [-168, -586], // N
  [-284, -522], //    descending under the canopy
  [-336, -404], // O
  [-296, -298], //    S-curve
  [-372, -196], // P
  [-468, -118], //    white house + mailbox
  [-476, 18], // Q
  [-406, 124], //
  [-334, 228], // R
  [-246, 316], // S
]

/** The brook: rises inside the loop and runs out under the covered bridge. */
export const STREAM_POINTS: V2[] = [
  [52, -36],
  [100, 12],
  [150, 70],
  [212, 124],
  [262, 168],
  [318, 214],
  [392, 292],
  [470, 380],
  [560, 470],
  [680, 590],
  [820, 720],
  [990, 860],
  [1200, 1000],
  [1500, 1160],
]

export const BRIDGE = {
  // centre and axis are snapped to the road at runtime
  center: [262, 168] as V2,
  length: 36,
}

export interface Clearing {
  poly: V2[]
  /** metres of soft, ragged forest edge */
  feather: number
  kind: 'field' | 'lawn' | 'meadow' | 'overlook'
}

export const CLEARINGS: Clearing[] = [
  // first white house clearing (B)
  { kind: 'lawn', feather: 14, poly: [[40, 330], [150, 318], [176, 380], [120, 440], [40, 430]] },
  // bright open valley after the bridge
  {
    kind: 'meadow',
    feather: 22,
    poly: [[268, 120], [330, 40], [420, -20], [470, 60], [440, 160], [380, 230], [300, 230]],
  },
  // the farm: hay field + pasture east of the road
  {
    kind: 'field',
    feather: 12,
    poly: [[470, -150], [560, -190], [680, -160], [720, -30], [690, 90], [600, 150], [500, 110], [470, 30]],
  },
  // upper pasture on the hillside below the overlook
  { kind: 'field', feather: 16, poly: [[560, -300], [660, -330], [700, -230], [620, -200], [560, -220]] },
  // the overlook: trees pulled away north of the crest
  {
    kind: 'overlook',
    feather: 26,
    poly: [[150, -560], [300, -560], [330, -640], [250, -760], [60, -780], [-10, -690], [40, -620]],
  },
  // west house (P)
  { kind: 'lawn', feather: 12, poly: [[-540, -270], [-470, -290], [-430, -200], [-470, -150], [-540, -170]] },
  // field across the brook, seen from the bridge
  { kind: 'meadow', feather: 18, poly: [[330, 250], [430, 300], [470, 380], [400, 420], [330, 340]] },
  // the village green to the north west (seen from the overlook)
  { kind: 'lawn', feather: 20, poly: [[-660, -1250], [-540, -1235], [-500, -1320], [-580, -1385], [-680, -1340]] },
  { kind: 'field', feather: 24, poly: [[-80, -1270], [30, -1262], [50, -1330], [-60, -1350]] },
]

export interface HouseSpec {
  pos: V2
  /** rotation in radians; if facing road the builder overrides */
  rot?: number
  faceRoad?: boolean
  chimneySmoke?: boolean
  mailbox?: boolean
  scale?: number
  kind?: 'cape' | 'colonial' | 'farmhouse'
}

export const HOUSES: HouseSpec[] = [
  { pos: [112, 404], faceRoad: true, chimneySmoke: true, mailbox: true, kind: 'cape' },
  { pos: [498, 92], faceRoad: true, chimneySmoke: true, mailbox: true, kind: 'farmhouse' },
  { pos: [-498, -222], faceRoad: true, mailbox: true, kind: 'colonial' },
  // village to the north west
  { pos: [-575, -1268], rot: 0.3, kind: 'colonial' },
  { pos: [-528, -1305], rot: 0.1, kind: 'cape', chimneySmoke: false },
  { pos: [-645, -1300], rot: -0.2, kind: 'cape' },
  { pos: [-20, -1300], rot: 0.5, kind: 'farmhouse' },
]

export const BARN = { pos: [556, -48] as V2, rot: 0.25 }
export const SILO = { pos: [584, -74] as V2 }
export const CHURCH = { pos: [-596, -1340] as V2, rot: 0.25 }

/** Iconic lone maples standing in fields. */
export const LONE_TREES: { pos: V2; color: 'red' | 'orange' | 'gold'; scale: number }[] = [
  { pos: [640, -10], color: 'red', scale: 1.25 },
  { pos: [395, 150], color: 'orange', scale: 1.2 },
  { pos: [600, -260], color: 'gold', scale: 1.1 },
  { pos: [120, -700], color: 'orange', scale: 1.15 },
  { pos: [520, 60], color: 'gold', scale: 0.95 },
]

/** Arc-length windows (fractions of the loop) used for rhythm and props. */
export const TELEPHONE_RUN = { from: 0.94, to: 0.36 } // wraps across the start
