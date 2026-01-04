import { create } from "zustand";
import * as THREE from "three";
import { LOOP_RADIUS, HELIX_SEPARATION, LOOP_POINTS_COUNT, EXIT_SEPARATION, FORWARD_SEPARATION, SCALE } from "@/lib/config/scale";

export type CoasterMode = "build" | "ride" | "preview";

export interface LoopMetadata {
  entryPos: THREE.Vector3;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
  radius: number;
  theta: number; // 0 to 2π position in loop
}

export interface TrackPoint {
  id: string;
  position: THREE.Vector3;
  tilt: number;
  loopMeta?: LoopMetadata; // Present if this point is part of a loop
}

interface RollerCoasterState {
  mode: CoasterMode;
  trackPoints: TrackPoint[];
  selectedPointId: string | null;
  rideProgress: number;
  isRiding: boolean;
  rideSpeed: number;
  isDraggingPoint: boolean;
  isAddingPoints: boolean;
  isLooped: boolean;
  hasChainLift: boolean;
  showWoodSupports: boolean;
  isNightMode: boolean;
  cameraTarget: THREE.Vector3 | null;
  
  setMode: (mode: CoasterMode) => void;
  setCameraTarget: (target: THREE.Vector3 | null) => void;
  addTrackPoint: (position: THREE.Vector3) => void;
  updateTrackPoint: (id: string, position: THREE.Vector3) => void;
  updateTrackPointTilt: (id: string, tilt: number) => void;
  removeTrackPoint: (id: string) => void;
  createLoopAtPoint: (id: string) => void;
  selectPoint: (id: string | null) => void;
  clearTrack: () => void;
  setRideProgress: (progress: number) => void;
  setIsRiding: (riding: boolean) => void;
  setRideSpeed: (speed: number) => void;
  setIsDraggingPoint: (dragging: boolean) => void;
  setIsAddingPoints: (adding: boolean) => void;
  setIsLooped: (looped: boolean) => void;
  setHasChainLift: (hasChain: boolean) => void;
  setShowWoodSupports: (show: boolean) => void;
  setIsNightMode: (night: boolean) => void;
  startRide: () => void;
  stopRide: () => void;
}

let pointCounter = 0;

export const useRollerCoaster = create<RollerCoasterState>((set, get) => ({
  mode: "build",
  trackPoints: [],
  selectedPointId: null,
  rideProgress: 0,
  isRiding: false,
  rideSpeed: 1.0,
  isDraggingPoint: false,
  isAddingPoints: true,
  isLooped: false,
  hasChainLift: true,
  showWoodSupports: false,
  isNightMode: false,
  cameraTarget: null,
  
  setMode: (mode) => set({ mode }),
  
  setCameraTarget: (target) => set({ cameraTarget: target }),
  
  setIsDraggingPoint: (dragging) => set({ isDraggingPoint: dragging }),
  
  setIsAddingPoints: (adding) => set({ isAddingPoints: adding }),
  
  setIsLooped: (looped) => set({ isLooped: looped }),
  
  setHasChainLift: (hasChain) => set({ hasChainLift: hasChain }),
  
  setShowWoodSupports: (show) => set({ showWoodSupports: show }),
  
  setIsNightMode: (night) => set({ isNightMode: night }),
  
  addTrackPoint: (position) => {
    const id = `point-${++pointCounter}`;
    set((state) => ({
      trackPoints: [...state.trackPoints, { id, position: position.clone(), tilt: 0 }],
    }));
  },
  
  updateTrackPoint: (id, position) => {
    set((state) => ({
      trackPoints: state.trackPoints.map((point) =>
        point.id === id ? { ...point, position: position.clone() } : point
      ),
    }));
  },
  
  updateTrackPointTilt: (id, tilt) => {
    set((state) => ({
      trackPoints: state.trackPoints.map((point) =>
        point.id === id ? { ...point, tilt } : point
      ),
    }));
  },
  
  removeTrackPoint: (id) => {
    set((state) => ({
      trackPoints: state.trackPoints.filter((point) => point.id !== id),
      selectedPointId: state.selectedPointId === id ? null : state.selectedPointId,
    }));
  },
  
  createLoopAtPoint: (id) => {
    set((state) => {
      const pointIndex = state.trackPoints.findIndex((p) => p.id === id);
      if (pointIndex === -1) return state;
      
      const entryPoint = state.trackPoints[pointIndex];
      const entryPos = entryPoint.position.clone();
      
      // Calculate forward direction from track
      let forward = new THREE.Vector3(1, 0, 0);
      if (pointIndex > 0) {
        const prevPoint = state.trackPoints[pointIndex - 1];
        forward = entryPos.clone().sub(prevPoint.position);
        forward.y = 0;
        if (forward.length() < 0.1) {
          forward = new THREE.Vector3(1, 0, 0);
        }
        forward.normalize();
      }
      
      const loopRadius = LOOP_RADIUS;
      const totalLoopPoints = LOOP_POINTS_COUNT;
      const loopPoints: TrackPoint[] = [];
      const helixSeparation = HELIX_SEPARATION;
      
      // Compute right vector for corkscrew offset
      const up = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(forward, up).normalize();
      
      // Build helical loop with mild corkscrew
      // Lateral offset increases linearly throughout to separate entry from exit
      for (let i = 1; i <= totalLoopPoints; i++) {
        const t = i / totalLoopPoints; // 0 to 1
        const theta = t * Math.PI * 2; // 0 to 2π
        
        const forwardOffset = Math.sin(theta) * loopRadius;
        const verticalOffset = (1 - Math.cos(theta)) * loopRadius;
        
        // Gradual corkscrew: linear lateral offset
        const lateralOffset = t * helixSeparation;
        
        loopPoints.push({
          id: `point-${++pointCounter}`,
          position: new THREE.Vector3(
            entryPos.x + forward.x * forwardOffset + right.x * lateralOffset,
            entryPos.y + verticalOffset,
            entryPos.z + forward.z * forwardOffset + right.z * lateralOffset
          ),
          tilt: 0,
          loopMeta: {
            entryPos: entryPos.clone(),
            forward: forward.clone(),
            up: up.clone(),
            right: right.clone(),
            radius: loopRadius,
            theta: theta
          }
        });
      }
      
      // Get the next point (unchanged) so we can rejoin it
      const nextPoint = state.trackPoints[pointIndex + 1];
      
      // Loop exit position (last point of loop) - same as entry position
      const loopExit = loopPoints[loopPoints.length - 1].position.clone();
      
      // Use same right vector from loop generation for transition separation
      const exitSeparation = EXIT_SEPARATION;
      const forwardSeparation = FORWARD_SEPARATION;
      
      // Offset the loop exit both forward and laterally to clear the entry track
      const offsetLoopExit = loopExit.clone()
        .add(forward.clone().multiplyScalar(forwardSeparation))
        .add(right.clone().multiplyScalar(exitSeparation));
      
      // Hermite-style transition: respect both loop exit direction and legacy track direction
      const transitionPoints: TrackPoint[] = [];
      
      if (nextPoint) {
        const nextPos = nextPoint.position.clone();
        
        // Loop exit tangent: at θ=2π, tangent = forward
        const exitTangent = forward.clone();
        
        // Legacy track incoming direction (from nextPoint toward the point after)
        // If there's a point after nextPoint, use that to compute legacy direction
        const nextNextPoint = state.trackPoints[pointIndex + 2];
        let legacyTangent: THREE.Vector3;
        
        if (nextNextPoint) {
          // Direction the legacy track is heading
          legacyTangent = nextNextPoint.position.clone().sub(nextPos).normalize();
        } else {
          // No point after, just use direction from loop exit to next point
          legacyTangent = nextPos.clone().sub(loopExit).normalize();
        }
        
        // Cubic Hermite interpolation between loopExit and nextPos
        // P(t) = (2t³ - 3t² + 1)P0 + (t³ - 2t² + t)T0 + (-2t³ + 3t²)P1 + (t³ - t²)T1
        const distance = loopExit.distanceTo(nextPos);
        const tangentScale = distance * 0.5; // Scale tangents by half the distance
        
        const hermite = (t: number): THREE.Vector3 => {
          const t2 = t * t;
          const t3 = t2 * t;
          
          const h00 = 2*t3 - 3*t2 + 1;
          const h10 = t3 - 2*t2 + t;
          const h01 = -2*t3 + 3*t2;
          const h11 = t3 - t2;
          
          return new THREE.Vector3()
            .addScaledVector(loopExit, h00)
            .addScaledVector(exitTangent, h10 * tangentScale)
            .addScaledVector(nextPos, h01)
            .addScaledVector(legacyTangent, h11 * tangentScale);
        };
        
        // Sample 2 points along the Hermite curve
        transitionPoints.push({
          id: `point-${++pointCounter}`,
          position: hermite(0.33),
          tilt: 0
        });
        
        transitionPoints.push({
          id: `point-${++pointCounter}`,
          position: hermite(0.66),
          tilt: 0
        });
      }
      
      // Combine: original up to entry + loop + transitions + original remainder (unchanged)
      const newTrackPoints = [
        ...state.trackPoints.slice(0, pointIndex + 1),
        ...loopPoints,
        ...transitionPoints,
        ...state.trackPoints.slice(pointIndex + 1)
      ];
      
      return { trackPoints: newTrackPoints };
    });
  },
  
  selectPoint: (id) => set({ selectedPointId: id }),
  
  clearTrack: () => {
    set({ trackPoints: [], selectedPointId: null, rideProgress: 0, isRiding: false });
  },
  
  setRideProgress: (progress) => set({ rideProgress: progress }),
  
  setIsRiding: (riding) => set({ isRiding: riding }),
  
  setRideSpeed: (speed) => set({ rideSpeed: speed }),
  
  startRide: () => {
    const { trackPoints } = get();
    if (trackPoints.length >= 2) {
      set({ mode: "ride", isRiding: true, rideProgress: 0 });
    }
  },
  
  stopRide: () => {
    set({ mode: "build", isRiding: false, rideProgress: 0 });
  },
}));
