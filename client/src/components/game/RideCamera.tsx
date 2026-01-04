import { useRef, useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useRollerCoaster } from "@/lib/stores/useRollerCoaster";
import { getTrackCurve, getTrackTiltAtProgress } from "./Track";
import { CAMERA_HEIGHT, CAMERA_LERP, CHAIN_SPEED, MIN_RIDE_SPEED, GRAVITY_SCALE, LOOP_MIN_SPEED, LOOP_SPEED_BOOST } from "@/lib/config/scale";

export function RideCamera() {
  const { camera } = useThree();
  const { trackPoints, isRiding, rideProgress, setRideProgress, rideSpeed, stopRide, isLooped, hasChainLift } = useRollerCoaster();
  
  const curveRef = useRef<THREE.CatmullRomCurve3 | null>(null);
  const previousCameraPos = useRef(new THREE.Vector3());
  const previousRoll = useRef(0);
  const previousUp = useRef(new THREE.Vector3(0, 1, 0));
  const maxHeightReached = useRef(0);
  const previousFov = useRef(75);
  const previousPitchOffset = useRef(0);
  
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
      // Reset up vector for new ride
      previousUp.current.set(0, 1, 0);
    }
  }, [isRiding]);
  
  useFrame((_, delta) => {
    if (!isRiding || !curveRef.current) return;
    
    const curve = curveRef.current;
    const curveLength = curve.getLength();
    const currentPoint = curve.getPoint(rideProgress);
    const currentHeight = currentPoint.y;
    
    // Check if current position is inside a loop for physics adjustment
    const totalPoints = trackPoints.length;
    const approxPointIndex = Math.floor(rideProgress * (totalPoints - 1));
    const currentTrackPoint = trackPoints[Math.min(approxPointIndex, totalPoints - 1)];
    const isCurrentlyInLoop = currentTrackPoint?.loopMeta !== undefined;
    
    let speed: number;
    
    if (hasChainLift && rideProgress < firstPeakT) {
      speed = CHAIN_SPEED * rideSpeed;
      maxHeightReached.current = Math.max(maxHeightReached.current, currentHeight);
    } else {
      maxHeightReached.current = Math.max(maxHeightReached.current, currentHeight);
      
      const gravity = 9.8 * GRAVITY_SCALE;
      const heightDrop = maxHeightReached.current - currentHeight;
      
      let energySpeed = Math.sqrt(2 * gravity * Math.max(0, heightDrop));
      
      // Apply loop speed boost and minimum speed to maintain momentum through loops
      if (isCurrentlyInLoop) {
        energySpeed = Math.max(LOOP_MIN_SPEED, energySpeed * LOOP_SPEED_BOOST);
      }
      
      speed = Math.max(MIN_RIDE_SPEED, energySpeed) * rideSpeed;
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
    
    const position = curve.getPoint(newProgress);
    const tangent = curve.getTangent(newProgress).normalize();
    
    // Parallel transport: maintain a stable up vector through vertical sections
    const dot = previousUp.current.dot(tangent);
    const upVector = previousUp.current.clone().sub(tangent.clone().multiplyScalar(dot));
    if (upVector.length() > 0.01) {
      upVector.normalize();
    } else {
      // Fallback if degenerate
      upVector.set(0, 1, 0);
      const d2 = upVector.dot(tangent);
      upVector.sub(tangent.clone().multiplyScalar(d2)).normalize();
    }
    
    // Re-check loop status at new progress position for camera orientation
    const newApproxPointIndex = Math.floor(newProgress * (totalPoints - 1));
    const newCurrentTrackPoint = trackPoints[Math.min(newApproxPointIndex, totalPoints - 1)];
    const isInLoop = newCurrentTrackPoint?.loopMeta !== undefined;
    
    // Prevent up vector inversion on non-loop sections
    // On flat/normal track, the up vector should always have positive Y component
    if (!isInLoop) {
      // Check if up vector has flipped (negative Y on relatively flat track)
      const tangentSteepness = Math.abs(tangent.y);
      if (tangentSteepness < 0.7 && upVector.y < 0) {
        // Flip the up vector back to correct orientation
        upVector.negate();
      }
    }
    
    previousUp.current.copy(upVector);
    
    // Apply bank/tilt by rotating up vector around the tangent
    const tilt = getTrackTiltAtProgress(trackPoints, newProgress, isLooped);
    const targetRoll = (tilt * Math.PI) / 180;
    
    // Snap roll to zero when track is level to prevent drift accumulation
    if (Math.abs(tilt) < 0.5) {
      previousRoll.current = 0;
    } else {
      previousRoll.current = previousRoll.current + (targetRoll - previousRoll.current) * CAMERA_LERP;
    }
    
    // Clamp very small roll values to zero to suppress numerical drift
    if (Math.abs(previousRoll.current) < 0.01) {
      previousRoll.current = 0;
    }
    
    // Create a quaternion to rotate around the tangent for banking
    const bankQuat = new THREE.Quaternion().setFromAxisAngle(tangent, -previousRoll.current);
    const bankedUp = upVector.clone().applyQuaternion(bankQuat);
    
    // Calculate slope intensity for thrill effects (0 = flat, 1 = straight down)
    const slopeIntensity = Math.max(0, -tangent.y);
    
    // On steep drops, pitch camera down slightly to see track ahead
    const targetPitchOffset = slopeIntensity * 0.25;
    previousPitchOffset.current = previousPitchOffset.current + (targetPitchOffset - previousPitchOffset.current) * CAMERA_LERP;
    
    // Apply pitch by rotating around the right vector (computed from banked up × tangent)
    const tempRight = new THREE.Vector3().crossVectors(bankedUp, tangent).normalize();
    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(tempRight, previousPitchOffset.current);
    const pitchedTangent = tangent.clone().applyQuaternion(pitchQuat);
    const pitchedUp = bankedUp.clone().applyQuaternion(pitchQuat);
    
    // Camera position: on track + height along banked up (before pitch)
    const cameraOffset = bankedUp.clone().multiplyScalar(CAMERA_HEIGHT);
    const targetCameraPos = position.clone().add(cameraOffset);
    
    // Build a proper right-handed basis AFTER pitch is applied
    // Camera looks down -Z, so zAxis = -forward
    const zAxis = pitchedTangent.clone().negate();
    const xAxis = new THREE.Vector3().crossVectors(pitchedUp, zAxis).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    
    // Build rotation matrix from basis vectors
    const rotationMatrix = new THREE.Matrix4();
    rotationMatrix.makeBasis(xAxis, yAxis, zAxis);
    const targetQuat = new THREE.Quaternion().setFromRotationMatrix(rotationMatrix);
    
    // Dynamic FOV: increase on steep drops for enhanced thrill (75 base, up to 90 on drops)
    const targetFov = 75 + slopeIntensity * 15;
    previousFov.current = previousFov.current + (targetFov - previousFov.current) * CAMERA_LERP;
    (camera as THREE.PerspectiveCamera).fov = previousFov.current;
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    
    // Smooth position and orientation
    previousCameraPos.current.lerp(targetCameraPos, CAMERA_LERP);
    camera.position.copy(previousCameraPos.current);
    camera.quaternion.slerp(targetQuat, CAMERA_LERP);
  });
  
  return null;
}
