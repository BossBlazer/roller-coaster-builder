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
  const transportedUp = useRef(new THREE.Vector3(0, 1, 0));
  const lastProgress = useRef(0);
  
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
      // Reset parallel transport up vector for new ride
      transportedUp.current.set(0, 1, 0);
      lastProgress.current = 0;
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
      
      // Higher minimum speed for smooth loops
      const minSpeed = 4.0;
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
    
    // Use parallel transport to maintain up vector through loops
    // This ensures camera stays INSIDE loops rather than jumping outside
    const prevTangent = curve.getTangent(lastProgress.current).normalize();
    
    // Calculate rotation from previous tangent to current tangent
    const rotationAxis = new THREE.Vector3().crossVectors(prevTangent, tangent);
    const rotationAngle = Math.acos(Math.min(1, Math.max(-1, prevTangent.dot(tangent))));
    
    // Only rotate if there's significant change
    if (rotationAxis.lengthSq() > 0.0001 && rotationAngle > 0.0001) {
      rotationAxis.normalize();
      // Rotate the transported up vector by the same rotation that took us from prevTangent to tangent
      transportedUp.current.applyAxisAngle(rotationAxis, rotationAngle);
    }
    
    // Re-orthogonalize to prevent drift
    const dot = transportedUp.current.dot(tangent);
    transportedUp.current.sub(tangent.clone().multiplyScalar(dot));
    if (transportedUp.current.lengthSq() > 0.0001) {
      transportedUp.current.normalize();
    } else {
      // Fallback if degenerate
      transportedUp.current.set(0, 1, 0);
      const d2 = transportedUp.current.dot(tangent);
      transportedUp.current.sub(tangent.clone().multiplyScalar(d2)).normalize();
    }
    
    lastProgress.current = newProgress;
    
    // Use un-tilted up vector for camera POSITION (keeps camera centered on track)
    const baseUpVector = transportedUp.current.clone();
    
    // Camera positioned directly on track centerline with height offset
    // Using base up vector (no tilt) ensures camera stays centered
    const cameraHeight = 1.2;
    const cameraOffset = baseUpVector.clone().multiplyScalar(cameraHeight);
    const targetCameraPos = position.clone().add(cameraOffset);
    
    // Apply track tilt only for camera ORIENTATION (not position)
    const tilt = getTrackTiltAtProgress(trackPoints, newProgress, isLooped);
    const tiltRad = (tilt * Math.PI) / 180;
    const orientationUp = baseUpVector.clone().applyAxisAngle(tangent, tiltRad);
    
    // Look directly down the track - use tangent direction for look target
    const lookDistance = 10;
    const targetLookAt = position.clone().add(tangent.clone().multiplyScalar(lookDistance));
    
    // Fast, tight camera following for less sway
    previousCameraPos.current.lerp(targetCameraPos, 0.5);
    previousLookAt.current.lerp(targetLookAt, 0.5);
    
    camera.position.copy(previousCameraPos.current);
    
    // Set camera's up vector for orientation (includes tilt for proper roll feel)
    camera.up.copy(orientationUp);
    camera.lookAt(previousLookAt.current);
  });
  
  return null;
}
