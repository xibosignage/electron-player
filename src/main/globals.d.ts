import ScheduleManager from "./common/scheduleManager";

declare global {
  interface Window {
    // Add your custom property to the Window interface
    ScheduleManager: ScheduleManager;
  }

  var window: Window;
}