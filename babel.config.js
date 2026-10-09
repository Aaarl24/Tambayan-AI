module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    // Required so the frame processor's 'worklet' functions work
    plugins: [
      'react-native-worklets-core/plugin',
      // Required by Reanimated 4; must be listed last
      'react-native-worklets/plugin',
    ],
  };
};