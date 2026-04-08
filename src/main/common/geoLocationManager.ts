import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createNanoEvents, Emitter } from 'nanoevents';

const execFileAsync = promisify(execFile);

interface GeoLocationEvents {
  geoLocationUpdated: () => void;
}

interface LocationResult {
  latitude: number;
  longitude: number;
}

interface IpGeoApiResponse {
  latitude: number;
  longitude: number;
}

/**
 * Handles retrieving and keeping the device's location updated in the main process.
 *
 * Platform strategy (tried in order, falls back on failure):
 *   Windows  → PowerShell + System.Device.Location (GPS / WiFi / cell)
 *   Linux    → GeoClue2 via Python3 subprocess
 *   Fallback → IP geolocation via axios (least accurate, always available)
 *
 * The manager filters incoming updates using a minimum distance and minimum
 * interval so the player only accepts meaningful location changes.
 *
 * Public methods:
 * - `start()` - Begins polling for location updates.
 * - `stop()`  - Cancels the polling timer.
 * - `getCurrentLocation()` - Returns the latest accepted coordinates.
 * - `isCurrentLocationInsidePolygon()` - Checks if the current location falls
 *   inside the given polygon for geofence-based layout filtering.
 */
export class GeoLocationManager {
  emitter: Emitter<GeoLocationEvents>;

  currentLatitude: number | null = null;
  currentLongitude: number | null = null;
  updatedAt: number | null = null;

  private readonly minimumDistance: number;
  private readonly minimumInterval: number;
  private readonly pollInterval: number;
  private readonly ipFallbackEndpoint: string;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param minimumDistance    - Minimum movement in meters before an update is accepted.
   * @param minimumInterval    - Minimum time in seconds between accepted updates.
   * @param pollInterval       - How often in milliseconds to poll for a new location. Defaults to 5 minutes.
   * @param ipFallbackEndpoint - IP geolocation endpoint used when OS location is unavailable.
   */
  constructor(
    minimumDistance = 200,
    minimumInterval = 120,
    pollInterval = 5 * 60 * 1000,
    ipFallbackEndpoint = 'https://ipapi.co/json/'
  ) {
    this.minimumDistance = minimumDistance;
    this.minimumInterval = minimumInterval;
    this.pollInterval = pollInterval;
    this.ipFallbackEndpoint = ipFallbackEndpoint;
    this.emitter = createNanoEvents<GeoLocationEvents>();
  }

  on<E extends keyof GeoLocationEvents>(event: E, callback: GeoLocationEvents[E]) {
    return this.emitter.on(event, callback);
  }

  /**
   * Starts polling for location updates.
   * An initial fetch is performed immediately, then repeated on the configured interval.
   */
  public start() {
    if (this.pollTimer !== null) {
      console.debug('[GeoLocationManager] Already started, ignoring start() call');
      return;
    }

    this.fetchAndUpdate();

    this.pollTimer = setInterval(() => {
      this.fetchAndUpdate();
    }, this.pollInterval);

    console.debug('[GeoLocationManager] Polling started', { pollInterval: this.pollInterval });
  }

  /**
   * Stops the polling timer.
   */
  public stop() {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.debug('[GeoLocationManager] Polling stopped');
    }
  }

  /**
   * Resolves the current location using the best available provider for the platform,
   * falling back to IP geolocation if the OS-level method fails or is unavailable.
   */
  private async fetchLocation(): Promise<LocationResult | null> {
    let result: LocationResult | null = null;

    if (process.platform === 'win32') {
      result = await this.fetchWindowsLocation();
    } else if (process.platform === 'linux') {
      result = await this.fetchLinuxLocation();
    }

    if (!result) {
      console.debug('[GeoLocationManager] OS location unavailable, falling back to IP geolocation');
      result = await this.fetchIpLocation();
    }

    return result;
  }

  /**
   * Windows: resolves location via PowerShell + System.Device.Location.
   * Uses GeoPositionAccuracy.High so the OS will use GPS, WiFi, and cell in order.
   * The script is Base64-encoded to avoid all shell quoting and locale issues.
   */
  private async fetchWindowsLocation(): Promise<LocationResult | null> {
    // Force en-US culture so decimal separators are always '.' regardless of system locale.
    const script = `
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::GetCultureInfo('en-US')
Add-Type -AssemblyName System.Device
$watcher = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)
$watcher.Start()
$timeout = 10
$elapsed = 0
while ($watcher.Status -ne [System.Device.Location.GeoPositionStatus]::Ready -and $elapsed -lt $timeout) {
    Start-Sleep -Milliseconds 500
    $elapsed += 0.5
}
if ($watcher.Position.Location.IsUnknown) {
    Write-Output 'UNKNOWN'
} else {
    Write-Output ("{0},{1}" -f $watcher.Position.Location.Latitude, $watcher.Position.Location.Longitude)
}
$watcher.Stop()
$watcher.Dispose()
    `.trim();

    // -EncodedCommand avoids quote-escaping issues entirely
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    try {
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NonInteractive', '-NoProfile', '-EncodedCommand', encoded],
        { timeout: 15_000 }
      );

      const output = stdout.trim();
      if (!output || output === 'UNKNOWN') return null;

      return this.parseCoordinates(output);
    } catch (err) {
      console.debug('[GeoLocationManager] Windows location failed', { err });
      return null;
    }
  }

  /**
   * Linux: resolves location via GeoClue2 using a Python3 subprocess.
   * GeoClue2 is the standard Linux location daemon and is available on
   * Ubuntu, Fedora, Debian, and most modern distros. It uses GPS, WiFi,
   * and MLS (Mozilla Location Service) depending on available hardware.
   *
   * Requires: python3, python3-gi, gir1.2-geoclue-2.0
   */
  private async fetchLinuxLocation(): Promise<LocationResult | null> {
    const script = `
import gi, sys
gi.require_version('Geoclue', '2.0')
from gi.repository import Geoclue, GLib

loop = GLib.MainLoop()
found = {}

def on_location(simple, _pspec):
    loc = simple.get_location()
    if loc:
        found['lat'] = loc.get_property('latitude')
        found['lon'] = loc.get_property('longitude')
    loop.quit()

try:
    simple = Geoclue.Simple.new_sync('xibo-player', Geoclue.AccuracyLevel.EXACT, None)
    loc = simple.get_location()
    if loc:
        print(str(loc.get_property('latitude')) + ',' + str(loc.get_property('longitude')))
        sys.exit(0)
    simple.connect('notify::location', on_location)
    GLib.timeout_add_seconds(10, loop.quit)
    loop.run()
    if found:
        print(str(found['lat']) + ',' + str(found['lon']))
    else:
        sys.exit(1)
except Exception as e:
    print('ERROR: ' + str(e), file=sys.stderr)
    sys.exit(1)
    `.trim();

    try {
      const { stdout } = await execFileAsync(
        'python3',
        ['-c', script],
        { timeout: 15_000 }
      );

      const output = stdout.trim();
      if (!output) return null;

      return this.parseCoordinates(output);
    } catch (err) {
      console.debug('[GeoLocationManager] Linux GeoClue2 location failed', { err });
      return null;
    }
  }

  /**
   * Fallback: resolves location from the device's public IP address.
   * Accuracy varies — typically city-level. Used when OS location is unavailable.
   */
  private async fetchIpLocation(): Promise<LocationResult | null> {
    try {
      const response = await axios.get<IpGeoApiResponse>(this.ipFallbackEndpoint, {
        timeout: 10_000,
      });

      const { latitude, longitude } = response.data;

      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        console.debug('[GeoLocationManager] IP API response missing latitude/longitude', response.data);
        return null;
      }

      return { latitude, longitude };
    } catch (err) {
      console.debug('[GeoLocationManager] IP geolocation failed', { err });
      return null;
    }
  }

  /**
   * Parses a "lat,lon" string into a LocationResult.
   * Returns null if either value is not a finite number.
   */
  private parseCoordinates(value: string): LocationResult | null {
    const parts = value.split(',');
    if (parts.length !== 2) return null;

    const latitude = parseFloat(parts[0]);
    const longitude = parseFloat(parts[1]);

    if (!isFinite(latitude) || !isFinite(longitude)) return null;

    return { latitude, longitude };
  }

  /**
   * Fetches a fresh location and feeds it into the update filter.
   */
  private async fetchAndUpdate() {
    console.debug('[GeoLocationManager] Fetching location');

    const result = await this.fetchLocation();

    if (!result) {
      console.debug('[GeoLocationManager] All location providers failed');
      return;
    }

    this.onUpdate(result.latitude, result.longitude);
  }

  /**
   * Handles a new location reading by comparing it against the last accepted coordinates.
   * Only meaningful changes pass through and trigger the update event.
   */
  private onUpdate(newLatitude: number, newLongitude: number) {
    const now = Date.now();

    console.debug('[GeoLocationManager] Received location update', { newLatitude, newLongitude });

    if (this.currentLatitude === null ||
        this.currentLongitude === null ||
        this.updatedAt === null) {

      this.currentLatitude = newLatitude;
      this.currentLongitude = newLongitude;
      this.updatedAt = now;

      console.debug('[GeoLocationManager] Initial location set', {
        latitude: this.currentLatitude,
        longitude: this.currentLongitude,
      });

      this.emitter.emit('geoLocationUpdated');
      return;
    }

    const distanceMoved = this.distanceBetween(
      this.currentLatitude,
      this.currentLongitude,
      newLatitude,
      newLongitude
    );
    const timePassed = (now - this.updatedAt) / 1000;

    if (distanceMoved < this.minimumDistance && timePassed < this.minimumInterval) {
      console.debug('[GeoLocationManager] Update ignored, thresholds not met', { distanceMoved, timePassed });
      return;
    }

    this.currentLatitude = newLatitude;
    this.currentLongitude = newLongitude;
    this.updatedAt = now;

    console.debug('[GeoLocationManager] Location update accepted', {
      latitude: this.currentLatitude,
      longitude: this.currentLongitude,
    });

    this.emitter.emit('geoLocationUpdated');
  }

  /**
   * Calculates the distance in meters between two coordinates using the Haversine formula.
   */
  private distanceBetween(
    currentLatitude: number,
    currentLongitude: number,
    newLatitude: number,
    newLongitude: number
  ): number {
    const earthRadius = 6371000;
    const toRadians = (v: number) => v * Math.PI / 180;

    const dLat = toRadians(newLatitude - currentLatitude);
    const dLon = toRadians(newLongitude - currentLongitude);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLon / 2) * Math.sin(dLon / 2) *
      Math.cos(toRadians(currentLatitude)) * Math.cos(toRadians(newLatitude));

    return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Returns the latest accepted latitude and longitude.
   */
  public getCurrentLocation() {
    return {
      latitude: this.currentLatitude,
      longitude: this.currentLongitude,
    };
  }

  /**
   * Checks whether the device's current geolocation falls inside the given polygon.
   * The polygon must be provided as an array of [longitude, latitude] pairs.
   */
  public isCurrentLocationInsidePolygon(polygonCoordinates: number[][]) {
    if (this.currentLatitude === null || this.currentLongitude === null) {
      return false;
    }

    const latitude = this.currentLatitude;
    const longitude = this.currentLongitude;
    let isInside = false;

    for (
      let i = 0, j = polygonCoordinates.length - 1;
      i < polygonCoordinates.length;
      j = i++
    ) {
      const xi = polygonCoordinates[i][0], yi = polygonCoordinates[i][1];
      const xj = polygonCoordinates[j][0], yj = polygonCoordinates[j][1];

      const intersects = (yi > latitude) !== (yj > latitude) &&
        longitude < (xj - xi) * (latitude - yi) / (yj - yi) + xi;

      if (intersects) isInside = !isInside;
    }

    return isInside;
  }
}

export const geoLocationManager = new GeoLocationManager();
