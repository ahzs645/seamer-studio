declare module 'n8ao' {
	import type { Camera, Color, Scene, WebGLRenderTarget } from 'three';
	import { Pass } from 'three/addons/postprocessing/Pass.js';

	export interface N8AOConfiguration {
		aoSamples: number;
		aoRadius: number;
		aoTones: number;
		denoiseSamples: number;
		denoiseRadius: number;
		distanceFalloff: number;
		intensity: number;
		denoiseIterations: number;
		renderMode: number;
		biasOffset: number;
		biasMultiplier: number;
		color: Color;
		gammaCorrection: boolean;
		depthBufferType: number;
		screenSpaceRadius: boolean;
		halfRes: boolean;
		depthAwareUpsampling: boolean;
		autoRenderBeauty: boolean;
		colorMultiply: boolean;
		transparencyAware: boolean;
		stencil: boolean;
		accumulate: boolean;
	}

	export class N8AOPass extends Pass {
		constructor(scene: Scene, camera: Camera, width?: number, height?: number);
		scene: Scene;
		camera: Camera;
		width: number;
		height: number;
		configuration: N8AOConfiguration;
		beautyRenderTarget: WebGLRenderTarget;
		setDisplayMode(mode: 'Combined' | 'AO' | 'No AO' | 'Split' | 'Split AO'): void;
		setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
	}

	export class N8AOPostPass extends Pass {
		constructor(scene: Scene, camera: Camera, width?: number, height?: number);
		scene: Scene;
		camera: Camera;
		width: number;
		height: number;
		configuration: N8AOConfiguration;
		beautyRenderTarget: WebGLRenderTarget;
		setDisplayMode(mode: 'Combined' | 'AO' | 'No AO' | 'Split' | 'Split AO'): void;
		setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
	}
}
