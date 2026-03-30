import { desktopCapturer } from "electron";

export async function captureDesktop(): Promise<string | null> {
  try {
    const sources = await desktopCapturer.getSources({ 
        types: ['screen'],
      })

      // We'll just grab the first screen available
      const primaryScreen = sources[0]
      
      // 1. Convert the NativeImage to a raw PNG Buffer
      const imageBuffer = primaryScreen.thumbnail.toPNG()
      
      // 2. Convert the Buffer to a base64 string
      return imageBuffer.toString('base64');
  } catch (error) {
    console.error('Error capturing desktop:', error);
    return null;
  }
}
