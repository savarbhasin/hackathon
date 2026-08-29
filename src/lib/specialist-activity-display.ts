export type SpecialistActivityDisplayGroup<T> =
  | { type: "item"; item: T }
  | { type: "tools"; items: T[] };

/** Merge adjacent tool rows without moving them across narration or status rows. */
export function groupConsecutiveSpecialistTools<T extends { kind?: string }>(
  items: readonly T[],
): SpecialistActivityDisplayGroup<T>[] {
  const groups: SpecialistActivityDisplayGroup<T>[] = [];

  for (const item of items) {
    if (item.kind !== "tool") {
      groups.push({ type: "item", item });
      continue;
    }

    const latest = groups[groups.length - 1];
    if (latest?.type === "tools") latest.items.push(item);
    else groups.push({ type: "tools", items: [item] });
  }

  return groups;
}
