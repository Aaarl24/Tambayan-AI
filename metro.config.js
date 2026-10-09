const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// Allow `require('./assets/ssd_mobilenet_v1.tflite')`
config.resolver.assetExts.push('tflite');

module.exports = withNativeWind(config, { input: './global.css' });