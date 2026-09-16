declare module 'lunar-javascript' {
  export class Solar {
    static fromDate(date: Date): Solar
    static fromYmd(year: number, month: number, day: number): Solar
    getLunar(): Lunar
    getYear(): number
    getMonth(): number
    getDay(): number
  }

  export class Lunar {
    getYear(): number
    getMonth(): number
    getDay(): number
    getDayInChinese(): string
    getMonthInChinese(): string
    getYearInGanZhi(): string
    getYearShengXiao(): string
    getJieQi(): string
    getPrevJieQi(): Solar
    getNextJieQi(): Solar
  }
}
