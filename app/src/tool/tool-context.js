"use strict";
/**
 * 工具执行上下文 — 每次 Agent Loop 调用工具时传入，替代全局变量注入
 *
 * 解决全局 setXxxContext() 在并发场景下的竞态问题，
 * 所有工具通过 execute(params, ctx) 的第二个参数获取调用上下文。
 */
Object.defineProperty(exports, "__esModule", { value: true });
