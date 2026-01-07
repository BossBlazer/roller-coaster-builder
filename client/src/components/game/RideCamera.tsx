import { useRef, useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useRollerCoaster } from "@/lib/stores/useRollerCoaster";
import { getTrackCurve, getTrackTiltAtProgress } from "./Track";

export function RideCamera() {
  const { camera } = useThree();
  const { trackPoints, isRiding, rideProgress, setRideProgress, rideSpeed, stopRide, isLooped, hasChainLift } = useRollerCoaster();
  
  const curveRef = useRef<THREE.CatmullRomCurve3 | null>(null);
  const previousCameraPos = useRef(new THREE.Vector3());
  const previousLookAt = useRef(new THREE.Vector3());
  const maxHeightReached = useRef(0);
  
  const firstPeakT = useMemo(() => {
    if (trackPoints.length < 2) return 0;
    
    const curve = getTrackCurve(trackPoints, isLooped);
    if (!curve) return 0;
    
    let maxHeight = -Infinity;
    let peakT = 0;
    let foundClimb = false;
    
    for (let t = 0; t <= 0.5; t += 0.01) {
      const point = curve.getPoint(t);
      const tangent = curve.getTangent(t);
      
      if (tangent.y > 0.1) {
        foundClimb = true;
      }
      
      if (foundClimb && point.y > maxHeight) {
        maxHeight = point.y;
        peakT = t;
      }
      
      if (foundClimb && tangent.y < -0.1 && t > peakT) {
        break;
      }
    }
    
    return peakT > 0 ? peakT : 0.2;
  }, [trackPoints, isLooped]);
  
  useEffect(() => {
    curveRef.current = getTrackCurve(trackPoints, isLooped);
  }, [trackPoints, isLooped]);
  
  useEffect(() => {
    if (isRiding && curveRef.current) {
      const startPoint = curveRef.current.getPoint(0);
      maxHeightReached.current = startPoint.y;
    }
  }, [isRiding]);
  
  useFrame((_, delta) => {
    if (!isRiding || !curveRef.current) return;
    
    const curve = curveRef.current;
    const curveLength = curve.getLength();
    const currentPoint = curve.getPoint(rideProgress);
    const currentHeight = currentPoint.y;
    
    let speed: number;
    
    if (hasChainLift && rideProgress < firstPeakT) {
      const chainSpeed = 0.9 * rideSpeed;
      speed = chainSpeed;
      maxHeightReached.current = Math.max(maxHeightReached.current, currentHeight);
    } else {
      maxHeightReached.current = Math.max(maxHeightReached.current, currentHeight);
      
      const gravity = 9.8;
      const heightDrop = maxHeightReached.current - currentHeight;
      
      const energySpeed = Math.sqrt(2 * gravity * Math.max(0, heightDrop));
      
      const minSpeed = 1.0;
      speed = Math.max(minSpeed, energySpeed) * rideSpeed;
    }
    
    const progressDelta = (speed * delta) / curveLength;
    let newProgress = rideProgress + progressDelta;
    
    if (newProgress >= 1) {
      if (isLooped) {
        newProgress = newProgress % 1;
        if (hasChainLift) {
          const startPoint = curve.getPoint(0);
          maxHeightReached.current = startPoint.y;
        }
      } else {
        stopRide();
        return;
      }
    }
    
    setRideProgress(newProgress);
    
    // Get current position and tangent
    const position = curve.getPoint(newProgress);
    const tangent = curve.getTangent(newProgress).normalize();
    
    // Calculate up vector from tangent and world up (no parallel transport drift)
    const worldUp = new THREE.Vector3(0, 1, 0);
    
    // Get right vector by crossing tangent with world up
    let right = new THREE.Vector3().crossVectors(tangent, worldUp);
    
    // Handle vertical sections where tangent is parallel to world up
    if (right.lengthSq() < 0.001) {
      // Use previous right direction as fallback
      right.set(1, 0, 0);
    }
    right.normalize();
    
    // Calculate base up vector perpendicular to tangent
    const baseUp = new THREE.Vector3().crossVectors(right, tangent).normalize();
    
    // Apply track tilt rotation around tangent axis
    const tilt = getTrackTiltAtProgress(trackPoints, newProgress, isLooped);
    const tiltRad = (tilt * Math.PI) / 180;
    
    // Rotate baseUp around tangent by tilt angle
    const upVector = baseUp.clone().applyAxisAngle(tangent, tiltRad);
    
    // Camera positioned directly on track with small height offset
    const cameraHeight = 1.5;
    const cameraOffset = upVector.clone().multiplyScalar(cameraHeight);
    const targetCameraPos = position.clone().add(cameraOffset);
    
    // Look ahead along the track for stable forward view
    const lookAheadT = isLooped 
      ? (newProgress + 0.03) % 1 
      : Math.min(newProgress + 0.03, 0.999);
    const lookAtPoint = curve.getPoint(lookAheadT);
    
    // Look at point ahead with matching height offset
    const targetLookAt = lookAtPoint.clone().add(upVector.clone().multiplyScalar(cameraHeight * 0.8));
    
    // Smooth camera movement
    previousCameraPos.current.lerp(targetCameraPos, 0.25);
    previousLookAt.current.lerp(targetLookAt, 0.25);
    
    camera.position.copy(previousCameraPos.current);
    camera.lookAt(previousLookAt.current);
  });
  
  return null;
}
