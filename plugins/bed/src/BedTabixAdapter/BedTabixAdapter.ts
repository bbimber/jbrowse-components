/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BaseFeatureDataAdapter,
  BaseOptions,
} from '@jbrowse/core/data_adapters/BaseAdapter'
import { FileLocation, Region } from '@jbrowse/core/util/types'
import { openLocation } from '@jbrowse/core/util/io'
import { ObservableCreate } from '@jbrowse/core/util/rxjs'
import SimpleFeature, { Feature } from '@jbrowse/core/util/simpleFeature'
import { Instance } from 'mobx-state-tree'
import { readConfObject } from '@jbrowse/core/configuration'
import { AnyConfigurationModel } from '@jbrowse/core/configuration/configurationSchema'
import { ucscProcessedTranscript } from '../util'
import MyConfigSchema from './configSchema'

export default class BedTabixAdapter extends BaseFeatureDataAdapter {
  protected config: AnyConfigurationModel

  public static capabilities = ['getFeatures', 'getRefNames']

  protected cachedSetup: any

  public constructor(config: Instance<typeof MyConfigSchema>) {
    super(config)
    this.config = config
  }

  protected async setup() {
    if (!this.cachedSetup) {
      this.cachedSetup = await Promise.all([
        import('@gmod/bed'),
        import('@gmod/tabix'),
      ]).then(async ([BED, { TabixIndexedFile }]) => {
        const bedGzLocation = readConfObject(
          this.config,
          'bedGzLocation',
        ) as FileLocation
        const index = readConfObject(this.config, 'index') as {
          indexType?: string
          location: FileLocation
        }
        const autoSql = readConfObject(this.config, 'autoSql') as string
        const { location, indexType } = index

        const bed = new TabixIndexedFile({
          filehandle: openLocation(bedGzLocation),
          csiFilehandle:
            indexType === 'CSI' ? openLocation(location) : undefined,
          tbiFilehandle:
            indexType !== 'CSI' ? openLocation(location) : undefined,
          chunkCacheSize: 50 * 2 ** 20,
        })
        const columnNames = readConfObject(this.config, 'columnNames')
        const scoreColumn = readConfObject(this.config, 'scoreColumn')
        const parser = new BED.default({ autoSql })
        return { parser, bed, columnNames, scoreColumn }
      })
    }
    return this.cachedSetup
  }

  public async getRefNames(opts: BaseOptions = {}) {
    const { bed } = await this.setup()
    return bed.getReferenceSequenceNames(opts)
  }

  async getHeader() {
    const { bed } = await this.setup()
    return bed.getHeader()
  }

  defaultParser(fields: string[], line: string) {
    return Object.fromEntries(line.split('\t').map((f, i) => [fields[i], f]))
  }

  async getNames() {
    const { bed, columnNames } = await this.setup()
    if (columnNames.length) {
      return columnNames
    }
    const header = await bed.getHeader()
    const defs = header.split('\n').filter(f => !!f)
    const defline = defs[defs.length - 1]
    return defline && defline.includes('\t')
      ? defline
          .slice(1)
          .split('\t')
          .map(field => field.trim())
      : null
  }

  public getFeatures(query: Region, opts: BaseOptions = {}) {
    return ObservableCreate<Feature>(async observer => {
      const { bed, parser, scoreColumn } = await this.setup()
      const meta = await bed.getMetadata()
      const { columnNumbers } = meta
      const colRef = columnNumbers.ref - 1
      const colStart = columnNumbers.start - 1
      const colEnd = columnNumbers.end - 1
      // colSame handles special case for tabix where a single column is both
      // the start and end, this is assumed to be covering the base at this
      // position (e.g. tabix -s 1 -b 2 -e 2) begin and end are same
      const colSame = colStart === colEnd ? 1 : 0
      const names = await this.getNames()
      await bed.getLines(query.refName, query.start, query.end, {
        lineCallback: (line: string, fileOffset: number) => {
          const l = line.split('\t')
          const refName = l[colRef]
          const start = +l[colStart]

          const end = +l[colEnd] + colSame
          const uniqueId = `${this.id}-${fileOffset}`
          const data = names
            ? this.defaultParser(names, line)
            : parser.parseLine(line, { uniqueId })

          const { blockCount, blockSizes, blockStarts, chromStarts } = data

          if (blockCount) {
            const starts = chromStarts || blockStarts || []
            const sizes = blockSizes
            const blocksOffset = start
            data.subfeatures = []

            for (let b = 0; b < blockCount; b += 1) {
              const bmin = (starts[b] || 0) + blocksOffset
              const bmax = bmin + (sizes[b] || 0)
              data.subfeatures.push({
                uniqueId: `${uniqueId}-${b}`,
                start: bmin,
                end: bmax,
                type: 'block',
              })
            }
          }

          if (scoreColumn) {
            data.score = data[scoreColumn]
          }
          delete data.chrom
          delete data.chromStart
          delete data.chromEnd
          const f = new SimpleFeature({
            ...data,
            start,
            end,
            refName,
            uniqueId,
          })
          const r = f.get('thickStart') ? ucscProcessedTranscript(f) : f
          observer.next(r)
        },
        signal: opts.signal,
      })
      observer.complete()
    }, opts.signal)
  }

  public freeResources(): void {}
}
