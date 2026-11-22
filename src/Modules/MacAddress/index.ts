// MAC address normalization and eligibility rules. They live in src/common, so
// the renderer's client editor applies the same ones; this is the main process's
// entry point to them.
export { NormalizeMacAddress, IsExternalMacAddress } from '../../common/mac-address';
