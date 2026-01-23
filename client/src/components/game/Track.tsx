import { useMemo } from "react";
import * as THREE from "three";
import { useRollerCoaster, LoopSegment } from "@/lib/stores/useRollerCoaster";
import { Line } from "@react-three/drei";

function interpolateTilt(trackPoints: { tilt: number }[], t: number, isLooped: boolean): number {
  if (trackPoints.length < 2) return 0;
  
  const n = trackPoints.length;
  const scaledT = isLooped ? t * n : t * (n - 1);
  const index = Math.floor(scaledT);
  const frac = scaledT - index;
  
  if (isLooped) {
    const i0 = index % n;
    const i1 = (index + 1) % n;
    return trackPoints[i0].tilt * (1 - frac) + trackPoints[i1].tilt * frac;
  } else {
    if (index >= n - 1) return trackPoints[n - 1].tilt;
    return trackPoints[index].tilt * (1 - frac) + trackPoints[index + 1].tilt * frac;
  }
}

interface RailSample {
  point: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  up: THREE.Vector3;
  tilt: number;
}

interface BarrelRollFrame {
  entryPos: THREE.Vector3;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
  radius: number;
  pitch: number;
}

// Vertical loop with corkscrew offset: track goes in a vertical circle but with
// lateral offset to prevent self-intersection at the bottom
// Rider goes upside down at the top (θ=π), loop is perpendicular to track direction
// θ(t) = 2π * (t - sin(2πt)/(2π)) ensures zero angular velocity at endpoints for C1 continuity
function sampleVerticalLoopAnalytically(
  frame: BarrelRollFrame,
  t: number  // 0 to 1
): { point: THREE.Vector3; tangent: THREE.Vector3; up: THREE.Vector3; normal: THREE.Vector3 } {
  const { entryPos, forward, up: U0, right: R0, radius, pitch } = frame;
  
  const twoPi = Math.PI * 2;
  
  // Corkscrew offset: separates ascending and descending parts of the loop
  // sin(θ) is positive going up, negative coming down
  const corkscrewOffset = radius * 0.4;  // 40% of radius for comfortable separation
  
  // Eased theta: starts and ends with zero angular velocity
  const theta = twoPi * (t - Math.sin(twoPi * t) / twoPi);
  const dThetaDt = twoPi * (1 - Math.cos(twoPi * t));
  
  // Vertical loop with lateral corkscrew:
  // - forward: radius*sin(θ) + pitch*t for forward/backward + advancement
  // - up: radius*(1-cos(θ)) for vertical motion (always >= 0)
  // - right: corkscrewOffset*sin(θ) separates up/down tracks laterally
  const point = new THREE.Vector3()
    .copy(entryPos)
    .addScaledVector(forward, pitch * t + radius * Math.sin(theta))
    .addScaledVector(U0, radius * (1 - Math.cos(theta)))
    .addScaledVector(R0, corkscrewOffset * Math.sin(theta));
  
  // Tangent: derivative of position including corkscrew term
  const tangent = new THREE.Vector3()
    .copy(forward).multiplyScalar(pitch + radius * Math.cos(theta) * dThetaDt)
    .addScaledVector(U0, radius * Math.sin(theta) * dThetaDt)
    .addScaledVector(R0, corkscrewOffset * Math.cos(theta) * dThetaDt)
    .normalize();
  
  // Up vector rotates around the RIGHT axis (perpendicular to the loop plane)
  // At θ=0: up = U0 (normal)
  // At θ=π: up = -U0 (upside down at top of loop!)
  // At θ=2π: up = U0 (back to normal)
  const rotatedUp = new THREE.Vector3()
    .addScaledVector(U0, Math.cos(theta))
    .addScaledVector(forward, -Math.sin(theta))
    .normalize();
  
  // Right vector stays constant (perpendicular to the loop plane)
  const normal = R0.clone();
  
  return { point, tangent, up: rotatedUp, normal };
}

export function Track() {
  const { trackPoints, loopSegments, isLooped, showWoodSupports, isNightMode } = useRollerCoaster();
  
  const { railData, woodSupports, trackLights } = useMemo(() => {
    if (trackPoints.length < 2) {
      return { railData: [], woodSupports: [], trackLights: [] };
    }
    
    const points = trackPoints.map((p) => p.position.clone());
    const baseSpline = new THREE.CatmullRomCurve3(points, isLooped, "catmullrom", 0.5);
    
    const loopMap = new Map<string, LoopSegment>();
    for (const seg of loopSegments) {
      loopMap.set(seg.entryPointId, seg);
    }
    
    const railData: RailSample[] = [];
    const numSamplesPerSegment = 20;
    const numTrackPoints = trackPoints.length;
    const totalSplineSegments = isLooped ? numTrackPoints : numTrackPoints - 1;
    
    // Pre-calculate total rollOffset from all loop elements
    // For closed tracks, we need to know the total offset to distribute compensation
    let totalLoopOffset = new THREE.Vector3(0, 0, 0);
    if (isLooped) {
      for (let i = 0; i < numTrackPoints; i++) {
        const loopSeg = loopMap.get(trackPoints[i].id);
        if (loopSeg) {
          const splineT = i / totalSplineSegments;
          const forward = baseSpline.getTangent(splineT).normalize();
          totalLoopOffset.addScaledVector(forward, loopSeg.pitch);
        }
      }
    }
    
    let prevTangent = baseSpline.getTangent(0).normalize();
    let prevUp = new THREE.Vector3(0, 1, 0);
    const initDot = prevUp.dot(prevTangent);
    prevUp.sub(prevTangent.clone().multiplyScalar(initDot));
    if (prevUp.length() < 0.01) {
      prevUp.set(1, 0, 0);
      const d = prevUp.dot(prevTangent);
      prevUp.sub(prevTangent.clone().multiplyScalar(d));
    }
    prevUp.normalize();
    
    let rollOffset = new THREE.Vector3(0, 0, 0);
    
    for (let pointIdx = 0; pointIdx < numTrackPoints; pointIdx++) {
      const currentPoint = trackPoints[pointIdx];
      const loopSeg = loopMap.get(currentPoint.id);
      
      if (loopSeg) {
        const splineT = pointIdx / totalSplineSegments;
        // Apply progressive compensation for closed tracks
        const loopCompensation = isLooped 
          ? totalLoopOffset.clone().multiplyScalar(-splineT)
          : new THREE.Vector3(0, 0, 0);
        const entryPos = baseSpline.getPoint(splineT).add(rollOffset.clone()).add(loopCompensation);
        const splineTangent = baseSpline.getTangent(splineT).normalize();
        
        const forward = splineTangent.clone();
        
        // Use WORLD up to build roll frame - this keeps the roll horizontal
        // and ensures it goes UP first, not into the ground
        const worldUp = new THREE.Vector3(0, 1, 0);
        let entryUp = worldUp.clone();
        const upDot = entryUp.dot(forward);
        entryUp.sub(forward.clone().multiplyScalar(upDot));
        if (entryUp.length() > 0.001) {
          entryUp.normalize();
        } else {
          // Forward is nearly vertical, use a fallback
          entryUp.set(1, 0, 0);
          const d = entryUp.dot(forward);
          entryUp.sub(forward.clone().multiplyScalar(d)).normalize();
        }
        
        const right = new THREE.Vector3().crossVectors(forward, entryUp).normalize();
        
        // Add a connecting sample at the loop entry point to bridge any gap
        // This ensures the track connects smoothly to the loop
        if (pointIdx > 0) {
          const entryNormal = new THREE.Vector3().crossVectors(forward, prevUp).normalize();
          railData.push({
            point: entryPos.clone(),
            tangent: forward.clone(),
            normal: entryNormal,
            up: prevUp.clone(),
            tilt: 0
          });
        }
        
        const rollFrame: BarrelRollFrame = {
          entryPos,
          forward,
          up: entryUp,
          right,
          radius: loopSeg.radius,
          pitch: loopSeg.pitch
        };
        
        const rollSamples = 64;  // More samples for smooth eased roll
        for (let i = 0; i <= rollSamples; i++) {
          const t = i / rollSamples;
          const sample = sampleVerticalLoopAnalytically(rollFrame, t);
          railData.push({
            point: sample.point,
            tangent: sample.tangent,
            normal: sample.normal,
            up: sample.up,
            tilt: 0
          });
        }
        
        rollOffset.addScaledVector(forward, loopSeg.pitch);
        
        // Exit: tangent should now match forward (since dθ/dt = 0 at t=1)
        prevTangent.copy(forward);  // Exit tangent is forward
        prevUp.copy(entryUp);  // After full rotation, up returns to entry up
      }
      
      if (pointIdx >= numTrackPoints - 1 && !isLooped) continue;
      
      for (let s = 0; s < numSamplesPerSegment; s++) {
        const localT = s / numSamplesPerSegment;
        const globalT = (pointIdx + localT) / totalSplineSegments;
        
        // For closed tracks, apply progressive compensation to close the loop
        // This subtracts a portion of the total loop offset based on progress
        const compensation = isLooped 
          ? totalLoopOffset.clone().multiplyScalar(-globalT)
          : new THREE.Vector3(0, 0, 0);
        
        const point = baseSpline.getPoint(globalT).add(rollOffset.clone()).add(compensation);
        const tangent = baseSpline.getTangent(globalT).normalize();
        const tilt = interpolateTilt(trackPoints, globalT, isLooped);
        
        // Use world-up anchored frame to keep track level at hill peaks
        // This prevents unwanted twist/roll when going over hills
        const worldUp = new THREE.Vector3(0, 1, 0);
        let up: THREE.Vector3;
        
        // Compute right vector from tangent and world up
        const right = new THREE.Vector3().crossVectors(tangent, worldUp);
        
        if (right.length() > 0.01) {
          // Normal case: tangent is not vertical
          right.normalize();
          up = new THREE.Vector3().crossVectors(right, tangent).normalize();
        } else {
          // Tangent is nearly vertical (going straight up or down)
          // Fall back to previous up vector to maintain continuity
          up = prevUp.clone();
          const upDot = up.dot(tangent);
          up.sub(tangent.clone().multiplyScalar(upDot));
          if (up.length() > 0.001) {
            up.normalize();
          } else {
            // Extreme case: use a fallback
            up.set(1, 0, 0);
            const d = up.dot(tangent);
            up.sub(tangent.clone().multiplyScalar(d)).normalize();
          }
        }
        
        prevTangent.copy(tangent);
        prevUp.copy(up);
        
        const normal = new THREE.Vector3().crossVectors(tangent, up).normalize();
        
        railData.push({ point, tangent, normal, up, tilt });
      }
    }
    
    if (!isLooped && trackPoints.length >= 2) {
      const lastPoint = baseSpline.getPoint(1).add(rollOffset);
      const lastTangent = baseSpline.getTangent(1).normalize();
      const lastTilt = trackPoints[trackPoints.length - 1].tilt;
      railData.push({
        point: lastPoint,
        tangent: lastTangent,
        normal: new THREE.Vector3().crossVectors(lastTangent, prevUp).normalize(),
        up: prevUp.clone(),
        tilt: lastTilt
      });
    }
    
    // For closed tracks, add a closing point that matches the first point
    if (isLooped && railData.length > 0) {
      // Add the first sample again to close the loop visually
      const firstSample = railData[0];
      railData.push({
        point: firstSample.point.clone(),
        tangent: firstSample.tangent.clone(),
        normal: firstSample.normal.clone(),
        up: firstSample.up.clone(),
        tilt: firstSample.tilt
      });
    }
    
    const woodSupports: { pos: THREE.Vector3; tangent: THREE.Vector3; height: number; tilt: number }[] = [];
    const supportInterval = 3;
    
    for (let i = 0; i < railData.length; i += supportInterval) {
      const { point, tangent, tilt } = railData[i];
      if (point.y > 1) {
        woodSupports.push({ 
          pos: point.clone(), 
          tangent: tangent.clone(),
          height: point.y,
          tilt
        });
      }
    }
    
    const trackLights: { pos: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    const lightInterval = 6;
    
    for (let i = 0; i < railData.length; i += lightInterval) {
      const { point, tangent } = railData[i];
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      trackLights.push({ pos: point.clone(), normal: normal.clone() });
    }
    
    return { railData, woodSupports, trackLights };
  }, [trackPoints, loopSegments, isLooped]);
  
  if (railData.length < 2) {
    return null;
  }
  
  // Scale factor for track elements - smaller values = smaller track, allowing bigger coasters
  const TRACK_SCALE = 0.6;
  
  const leftRail: [number, number, number][] = [];
  const rightRail: [number, number, number][] = [];
  const railOffset = 0.3 * TRACK_SCALE;
  
  for (let i = 0; i < railData.length; i++) {
    const { point, normal } = railData[i];
    
    leftRail.push([
      point.x + normal.x * railOffset,
      point.y + normal.y * railOffset,
      point.z + normal.z * railOffset,
    ]);
    rightRail.push([
      point.x - normal.x * railOffset,
      point.y - normal.y * railOffset,
      point.z - normal.z * railOffset,
    ]);
  }
  
  // Choose rail color based on day/night mode
  // Day: bright red, Night: cooler purple glow (adjust hexes if you prefer different colors)
  const railColor = isNightMode ? "#AA66FF" : "#ff4444";
  
  return (
    <group>
      <Line
        points={leftRail}
        color={railColor}
        lineWidth={4 * TRACK_SCALE}
      />
      <Line
        points={rightRail}
        color={railColor}
        lineWidth={4 * TRACK_SCALE}
      />
      
      {railData.filter((_, i) => i % 2 === 0).map((data, i) => {
        const { point, tangent, up } = data;
        
        const right = new THREE.Vector3().crossVectors(tangent, up).normalize();
        const matrix = new THREE.Matrix4().makeBasis(right, up, tangent);
        const euler = new THREE.Euler().setFromRotationMatrix(matrix);
        
        return (
          <mesh
            key={`tie-${i}`}
            position={[point.x, point.y - up.y * 0.08 * TRACK_SCALE, point.z]}
            rotation={euler}
          >
            <boxGeometry args={[1.0 * TRACK_SCALE, 0.08 * TRACK_SCALE, 0.12 * TRACK_SCALE]} />
            <meshStandardMaterial color="#8B4513" />
          </mesh>
        );
      })}
      
      {showWoodSupports && woodSupports.map((support, i) => {
        const { pos, tangent, height } = support;
        const angle = Math.atan2(tangent.x, tangent.z);
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
        
        const legInset = 0.15 * TRACK_SCALE;
        const leftLegX = pos.x + normal.x * (railOffset - legInset);
        const leftLegZ = pos.z + normal.z * (railOffset - legInset);
        const rightLegX = pos.x - normal.x * (railOffset - legInset);
        const rightLegZ = pos.z - normal.z * (railOffset - legInset);
        
        const crossbraceHeight = height * 0.6;
        const crossLength = Math.sqrt(Math.pow(railOffset * 2, 2) + Math.pow(crossbraceHeight, 2));
        const crossAngle = Math.atan2(crossbraceHeight, railOffset * 2);
        
        const legSize = 0.12 * TRACK_SCALE;
        const braceSize = 0.08 * TRACK_SCALE;
        const crossSize = 0.06 * TRACK_SCALE;
        
        return (
          <group key={`wood-${i}`}> 
            <mesh position={[leftLegX, height / 2, leftLegZ]}>
              <boxGeometry args={[legSize, height, legSize]} />
              <meshStandardMaterial color="#8B5A2B" />
            </mesh>
            <mesh position={[rightLegX, height / 2, rightLegZ]}>
              <boxGeometry args={[legSize, height, legSize]} />
              <meshStandardMaterial color="#8B5A2B" />
            </mesh>
            
            {height > 1.5 && (
              <> 
                {/* Horizontal braces at multiple heights */}
                <mesh 
                  position={[pos.x, height * 0.2, pos.z]} 
                  rotation={[0, angle, 0]}
                >
                  <boxGeometry args={[braceSize, braceSize, railOffset * 2.2]} />
                  <meshStandardMaterial color="#A0522D" />
                </mesh>
                <mesh 
                  position={[pos.x, height * 0.5, pos.z]} 
                  rotation={[0, angle, 0]}
                >
                  <boxGeometry args={[braceSize, braceSize, railOffset * 2.2]} />
                  <meshStandardMaterial color="#A0522D" />
                </mesh>
                <mesh 
                  position={[pos.x, height * 0.8, pos.z]} 
                  rotation={[0, angle, 0]}
                >
                  <boxGeometry args={[braceSize, braceSize, railOffset * 2.2]} />
                  <meshStandardMaterial color="#A0522D" />
                </mesh>
              </>
            )}
            
            {height > 2 && (
              <> 
                {/* X-pattern diagonal cross braces */}
                <mesh 
                  position={[pos.x, height * 0.35, pos.z]} 
                  rotation={[crossAngle, angle, 0]}
                >
                  <boxGeometry args={[crossSize, crossLength * 0.4, crossSize]} />
                  <meshStandardMaterial color="#CD853F" />
                </mesh>
                <mesh 
                  position={[pos.x, height * 0.35, pos.z]} 
                  rotation={[-crossAngle, angle, 0]}
                >
                  <boxGeometry args={[crossSize, crossLength * 0.4, crossSize]} />
                  <meshStandardMaterial color="#CD853F" />
                </mesh>
              </>
            )}
            
            {height > 4 && (
              <> 
                {/* Additional X-pattern for taller supports */}
                <mesh 
                  position={[pos.x, height * 0.65, pos.z]} 
                  rotation={[crossAngle, angle, 0]}
                >
                  <boxGeometry args={[crossSize, crossLength * 0.4, crossSize]} />
                  <meshStandardMaterial color="#CD853F" />
                </mesh>
                <mesh 
                  position={[pos.x, height * 0.65, pos.z]} 
                  rotation={[-crossAngle, angle, 0]}
                >
                  <boxGeometry args={[crossSize, crossLength * 0.4, crossSize]} />
                  <meshStandardMaterial color="#CD853F" />
                </mesh>
              </>
            )}
          </group>
        );
      })}
      
      {isNightMode && trackLights.map((light, i) => {
        const { pos, normal } = light;
        const leftX = pos.x + normal.x * 0.5 * TRACK_SCALE;
        const leftZ = pos.z + normal.z * 0.5 * TRACK_SCALE;
        const rightX = pos.x - normal.x * 0.5 * TRACK_SCALE;
        const rightZ = pos.z - normal.z * 0.5 * TRACK_SCALE;
        const colors = ["#FF0000", "#FFFF00", "#00FF00", "#00FFFF", "#FF00FF"];
        const color = colors[i % colors.length];
        
        return (
          <group key={`light-${i}`}> 
            <mesh position={[leftX, pos.y + 0.1, leftZ]}>
              <sphereGeometry args={[0.3 * TRACK_SCALE, 6, 6]} />
              <meshBasicMaterial color={color} />
            </mesh>
            <mesh position={[rightX, pos.y + 0.1, rightZ]}>
              <sphereGeometry args={[0.3 * TRACK_SCALE, 6, 6]} />
              <meshBasicMaterial color={color} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

export function getTrackCurve(trackPoints: { position: THREE.Vector3 }[], isLooped: boolean = false) {
  if (trackPoints.length < 2) return null;
  const points = trackPoints.map((p) => p.position.clone());
  return new THREE.CatmullRomCurve3(points, isLooped, "catmullrom", 0.5);
}

export function getTrackTiltAtProgress(trackPoints: { tilt: number }[], progress: number, isLooped: boolean): number {
  return interpolateTilt(trackPoints, progress, isLooped);
}