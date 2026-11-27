import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanImages, writeImages } from "../src/engine/session"

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex")
const url = (mime: string, b: Buffer) => `data:image/${mime};base64,${b.toString("base64")}`
let dir: string
let proj: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eclipse-img-"))
  process.env.PNC_HOME = join(dir, "data")
  proj = join(dir, "proj")
  mkdirSync(proj)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("seules les vraies images passent ; les autres sont comptées comme refusées", () => {
  const r = cleanImages([
    { name: "ok.png", dataUrl: url("png", PNG) },
    { name: "faux", dataUrl: url("png", Buffer.from("<script>alert(1)</script>")) }, // pas un PNG
    { name: "type", dataUrl: url("jpeg", PNG) }, // PNG déclaré JPEG
    { name: "b64", dataUrl: "data:image/png;base64,iVBORw0KGgo=====" }, // base64 invalide
    { name: "svg", dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" },
    "rien",
  ])
  expect(r.images.map((i) => i.name)).toEqual(["ok.png"])
  expect(r.rejected).toBe(5)
  expect(cleanImages(Array(7).fill({ name: "x", dataUrl: url("png", PNG) })).rejected).toBe(1) // 6 au plus
})

test("les images vont dans <projet>/.eclipse/images, octets intacts", () => {
  const [p] = writeImages(proj, cleanImages([{ name: "../../evil.png", dataUrl: url("png", PNG) }]).images)
  expect(p).toMatch(/^\.eclipse\/images\/[^/]+\.png$/)
  expect(readFileSync(join(proj, p)).equals(PNG)).toBe(true)
})

test("aucun lien symbolique suivi : .eclipse ou images qui pointent ailleurs sont refusés", () => {
  const dehors = join(dir, "dehors")
  mkdirSync(dehors)
  const imgs = cleanImages([{ name: "a.png", dataUrl: url("png", PNG) }]).images
  symlinkSync(dehors, join(proj, ".eclipse"))
  expect(() => writeImages(proj, imgs)).toThrow(/vrai dossier/)
  rmSync(join(proj, ".eclipse"))
  mkdirSync(join(proj, ".eclipse"))
  symlinkSync(dehors, join(proj, ".eclipse", "images"))
  expect(() => writeImages(proj, imgs)).toThrow(/vrai dossier/)
  expect(readdirSync(dehors)).toEqual([])
  expect(existsSync(join(dehors, "a.png"))).toBe(false)
})
