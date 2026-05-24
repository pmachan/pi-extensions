export const CAVEMAN_ICON = "🪨";

interface CavemanIndicatorState {
	present: boolean;
	active: boolean;
}

const state: CavemanIndicatorState = {
	present: false,
	active: false,
};

export function setCavemanIndicatorState(active: boolean): void {
	state.present = true;
	state.active = active;
}

export function getCavemanIndicatorState(): CavemanIndicatorState {
	return state;
}
