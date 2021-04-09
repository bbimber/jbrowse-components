/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BaseFeatureDataAdapter,
  BaseOptions,
} from '@jbrowse/core/data_adapters/BaseAdapter'
import { Region, FileLocation } from '@jbrowse/core/util/types'
import { openLocation } from '@jbrowse/core/util/io'
import { ObservableCreate } from '@jbrowse/core/util/rxjs'
import SimpleFeature, { Feature } from '@jbrowse/core/util/simpleFeature'
import { map, mergeAll } from 'rxjs/operators'
import { readConfObject } from '@jbrowse/core/configuration'
import { AnyConfigurationModel } from '@jbrowse/core/configuration/configurationSchema'
import { ucscProcessedTranscript } from '../util'

interface BEDFeature {
  chrom: string
  chromStart: number
  chromEnd: number
  [key: string]: any
}

interface Parser {
  parseLine: (line: string, opts: { uniqueId: string | number }) => BEDFeature
}

export default class BigBedAdapter extends BaseFeatureDataAdapter {
  public cachedSetup: any

  protected config: any

  public constructor(config: AnyConfigurationModel) {
    super(config)
    this.config = config
  }

  protected async setup() {
    if (!this.cachedSetup) {
      this.cachedSetup = await Promise.all([
        import('@gmod/bed'),
        import('@gmod/bbi'),
      ]).then(async ([BED, { BigBed }]) => {
        const bigBedLocation = readConfObject(
          this.config,
          'bigBedLocation',
        ) as FileLocation
        const bigbed = new BigBed({
          filehandle: openLocation(bigBedLocation),
        })
        const { autoSql } = await bigbed.getHeader()
        const parser = new BED.default({ autoSql })
        return { bigbed, parser }
      })
    }
    return this.cachedSetup
  }

  public async getRefNames() {
    const { bigbed } = await this.setup()
    return Object.keys((await bigbed.getHeader()).refsByName)
  }

  async getHeader(opts?: BaseOptions) {
    const { bigbed } = await this.setup()
    const { version, fileType } = await bigbed.getHeader(opts)
    // @ts-ignore
    const { autoSql } = await this.parser
    const { fields, ...rest } = autoSql
    const f = Object.fromEntries(
      // @ts-ignore
      fields.map(({ name, comment }) => [name, comment]),
    )
    return { version, fileType, autoSql: { ...rest }, fields: f }
  }

  public async refIdToName(refId: number) {
    const { bigbed } = await this.setup()
    return ((await bigbed.getHeader()).refsByNumber[refId] || {}).name
  }

  public getFeatures(region: Region, opts: BaseOptions = {}) {
    const { refName, start, end } = region
    const { signal } = opts
    return ObservableCreate<Feature>(async observer => {
      try {
        const { bigbed, parser } = await this.setup()
        const ob = await bigbed.getFeatureStream(refName, start, end, {
          signal,
          basesPerSpan: end - start,
        })
        ob.pipe(
          mergeAll(),
          map(
            (r: {
              start: number
              end: number
              rest?: string
              uniqueId?: string
            }) => {
              const data = parser.parseLine(
                `${refName}\t${r.start}\t${r.end}\t${r.rest}`,
                {
                  uniqueId: r.uniqueId as string,
                },
              )

              const { blockCount, blockSizes, blockStarts, chromStarts } = data
              if (blockCount) {
                const starts = chromStarts || blockStarts || []
                const sizes = blockSizes
                const blocksOffset = r.start
                data.subfeatures = []

                for (let b = 0; b < blockCount; b += 1) {
                  const bmin = (starts[b] || 0) + blocksOffset
                  const bmax = bmin + (sizes[b] || 0)
                  data.subfeatures.push({
                    uniqueId: `${r.uniqueId}-${b}`,
                    start: bmin,
                    end: bmax,
                    type: 'block',
                  })
                }
              }
              if (r.uniqueId === undefined) {
                throw new Error('invalid bbi feature')
              }
              delete data.chromStart
              delete data.chromEnd
              delete data.chrom

              const f = new SimpleFeature({
                id: `${this.id}-${r.uniqueId}`,
                data: {
                  ...data,
                  start: r.start,
                  end: r.end,
                  refName,
                },
              })

              // collection of heuristics for suggesting that this feature
              // should be converted to a gene, CNV bigbed has many gene like
              // features including thickStart and blockCount but no strand
              return f.get('thickStart') &&
                f.get('blockCount') &&
                f.get('strand') !== 0
                ? ucscProcessedTranscript(f)
                : f
            },
          ),
        ).subscribe(observer)
      } catch (e) {
        observer.error(e)
      }
    }, opts.signal)
  }

  public freeResources(): void {}
}
