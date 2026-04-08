
export class SspAd {
  id: string = '';
  adId: string = '';
  title: string = '';
  creativeId: string = '';
  duration: string = '';
  type: string = '';
  xiboType: string = '';
  width: number = 0;
  height: number = 0;

  // URLs
  url: string = '';
  impressionUrls: string[] = [];
  errorUrls: string[] = [];

  // Wrapper
  isWrapper: boolean = false;
  isWrapperResolved: boolean = false;
  isWrapperOpenImmediately: boolean = true;
  isWrapperResolving: boolean = false;
  wrapperAdTagUri: string = '';
  countWraps: number = 0;
  wrapperAllowedTypes: string[] = [];
  wrapperAllowedDuration: string = '';
  wrapperMaxDuration: number = 0;
  wrapperPartner: string = '';
  wrapperRateLimit: number = 0;
  wrapperFileScheme: string = 'creativeId';
  wrapperExtendUrl: string = '';
  wrapperHttpMethod: string = 'GET';

  // The GeoLocation
  isGeoAware: boolean = false;
  geoLocation: string = '';

  // Count of downloads
  countDownloads: number = 0;

  getAspectRatio(): number {
    return this.width / this.height;
  }

  getDurationInSeconds(): number {
    return this.getDurationFromString(this.duration);
  }

  getWrapperAllowedDurationInSeconds(): number {
    return this.getDurationFromString(this.wrapperAllowedDuration);
  }

  getDurationFromString(str: string): number {
    if (str == '') {
      return 0;
    }

    let p = str.split(':'),
      s = 0, m = 1;

    while (p.length > 0) {
      s += m * parseInt(<string>p.pop(), 10);
      m *= 60;
    }

    return s;
  }
}
