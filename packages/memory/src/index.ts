/**
 * W3 待实现：四类记忆层
 * - 增量写操作（借鉴 Mem0）：ADD / UPDATE / DELETE / NONE
 * - 语义记忆带 validUntil 时效；技能记忆为独立 .md 文件并版本化
 * - 最小上下文原则：检索结果只带业务结论，不带推理过程
 */
export type MemoryWriteOp = "ADD" | "UPDATE" | "DELETE" | "NONE";
