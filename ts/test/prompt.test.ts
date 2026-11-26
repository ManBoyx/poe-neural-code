import { expect, test } from "bun:test"
import { revealHidden, wrapToWidth } from "../src/ui/PermissionPrompt"

test("repli à la largeur d'écran : idéogrammes comptés double, aucun morceau ne dépasse, rien n'est perdu", () => {
  const line = "界".repeat(34) + "ARGUMENT_A_VERIFIER" + "界".repeat(34)
  const parts = wrapToWidth(line, 40)
  for (const p of parts) expect(Bun.stringWidth(p)).toBeLessThanOrEqual(40)
  expect(parts.map((p, i) => (i ? p.slice(2) : p)).join("")).toBe(line)
  expect(parts.some((p) => p.includes("ARGUMENT_A_VERIFIER") || p.includes("ARGUMENT"))).toBe(true)
})

test("caractères invisibles ou trompeurs rendus visibles", () => {
  expect(revealHidden("rm‮ -rf")).toBe("rm\\u{202E} -rf")
  expect(revealHidden("a​b")).toBe("a\\u{200B}b")
  expect(revealHidden("ligne 1\nligne 2 é")).toBe("ligne 1\nligne 2 é")
})
