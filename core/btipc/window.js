"use strict";
// BTIPC v1 窗口表(规格:docs/btipc-v1.md §6 状态机 / §14.2 窗口隔离)
// 所有传输状态收在 Map<win, Transfer>,读写只经本模块;窗口之间零共享、互不覆盖。
// 帧号不在这里累计 —— serveDL 用 frameIndex = round - frameStartRound 现算(§4.0 幂等)。

const WINDOW_TTL_MS = 60000; // §9:无活动 GC
// §6:END 帧被服务后 GC。必须 > 客户端最长重试跨度,否则窗口会在客户端还在重试时自毁:
//   最坏 = T_HARD(12s) + CRC_DEAD(8) × (STORM_TCLOSE 2.5s + 1s 冷却) ≈ 34s。
//   旧值 10s 会让 END 一被服务就开始倒计时,客户端随后必然全 404 → 错报 crc_dead。
const END_GC_MS = 45000;

class WindowTable {
  /** @param {{now?:()=>number, ttlMs?:number, endGcMs?:number}} [opts] */
  constructor(opts) {
    opts = opts || {};
    this.map = new Map();
    this.now = opts.now || Date.now;
    this.ttlMs = opts.ttlMs === undefined ? WINDOW_TTL_MS : opts.ttlMs;
    this.endGcMs = opts.endGcMs === undefined ? END_GC_MS : opts.endGcMs;
  }

  /** @param {string} win 6 位 hex */
  get(win) {
    return this.map.get(win) || null;
  }

  /**
   * REQ 到达(§6):同 win 幂等覆盖(超时重发是正常路径),新 win 建窗。
   * frames=null → 未就绪,serveDL 回固定 BUSY 帧。
   * @param {string} win
   * @param {number} id request_id(帧 B1..B2 同值)
   * @param {Buffer} payload 请求文本 UTF-8 字节
   */
  acceptReq(win, id, payload) {
    const t = this.now();
    const tr = {
      id: id,
      payload: payload,
      frames: null, // framer.encode 产物;null = 未就绪 → BUSY
      frameStartRound: null, // 首次被服务的轮号锚点,锚定后不变(§4.0)
      tReq: t,
      tLast: t,
      endServedAt: null,
    };
    this.map.set(win, tr);
    return tr;
  }

  /**
   * 帧就绪(回声即时;翻译完成后异步)。
   * @returns {boolean} 窗口不存在 → false(REQ 已被 GC 等极端情形)
   */
  setFrames(win, frames) {
    const tr = this.map.get(win);
    if (!tr) return false;
    tr.frames = frames;
    return true;
  }

  /** CAN 行/上层放弃 */
  cancel(win) {
    return this.map.delete(win);
  }

  /**
   * GC(§6):END 帧被服务后 endGcMs,或 tLast 距今超 ttlMs → 删。
   * @returns {number} 本轮删除数
   */
  gc() {
    const t = this.now();
    let removed = 0;
    for (const [win, tr] of this.map) {
      if (tr.endServedAt !== null && t - tr.endServedAt >= this.endGcMs) {
        this.map.delete(win);
        removed++;
      } else if (t - tr.tLast >= this.ttlMs) {
        this.map.delete(win);
        removed++;
      }
    }
    return removed;
  }

  size() {
    return this.map.size;
  }
}

module.exports = { WindowTable, WINDOW_TTL_MS, END_GC_MS };
