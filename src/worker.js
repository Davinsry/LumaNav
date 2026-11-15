import { computeOverlay } from './analysis.js'
import { makeDem } from './dem.js'

const dems = new Map()
onmessage = ({ data }) => {
  if (data.dem) {
    const d = makeDem(data.dem)
    dems.set(d.id, d)
    return
  }
  const dem = dems.get(data.demId)
  if (!dem) return
  const r = computeOverlay(dem, data, (p) => postMessage({ id: data.id, progress: p }))
  postMessage({ id: data.id, result: r }, [r.lit.buffer, r.see.buffer, r.both.buffer])
}
