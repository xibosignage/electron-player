export {}

import { Config } from '../../main/config/config';

declare global {
  interface Window {
    // Add your custom property to the Window interface
    config: Config;
  }
}