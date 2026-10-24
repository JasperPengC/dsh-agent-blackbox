/** 时间窗纯函数的类型声明（实现是 web/timeline-math.js，浏览器与 Node 共用） */
export type ViewWindow = { from: number; to: number }

export const MIN_WINDOW_MS: number

export function clampWindow(from: number, to: number, duration: number, minMs?: number): ViewWindow
export function zoomWindow(view: ViewWindow, duration: number, anchorT: number, factor: number, minMs?: number): ViewWindow
export function panWindow(view: ViewWindow, duration: number, deltaMs: number, minMs?: number): ViewWindow
export function brushWindow(a: number, b: number, duration: number, minMs?: number): ViewWindow
export function isFullWindow(view: ViewWindow, duration: number, eps?: number): boolean
export function xOf(t: number, view: ViewWindow, width: number): number
export function tOf(x: number, view: ViewWindow, width: number): number
export function intersects(start: number, end: number | null, view: ViewWindow): boolean
