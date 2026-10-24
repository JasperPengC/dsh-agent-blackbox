/**
 * 右侧列表空态文案
 * =================
 * 三种"空"必须区分开，否则加载中/筛选后/窗口外都会被误报成"没有匹配内容"：
 *   · 会话本身没有事件
 *   · 当前时间窗内没有事件（可以拖动时间轴看别处）
 *   · 搜索/筛选之后没有结果
 */
export function emptyStateMessage({ tab, filtered, spansCount, eventsCount, totalEvents = 0 }) {
  if (tab === 'tools') {
    if (filtered) return '没有匹配的工具调用'
    if (totalEvents === 0) return '这个会话还没有工具调用'
    return '当前时间窗内没有工具调用 · 拖动时间轴查看其它区间'
  }
  if (filtered) return '没有匹配内容'
  if (totalEvents === 0) return '这个会话还没有事件'
  return eventsCount === 0 ? '当前时间窗内没有事件 · 拖动时间轴查看其它区间' : '这个会话还没有事件'
}
