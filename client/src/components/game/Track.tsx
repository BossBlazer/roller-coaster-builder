import { useMemo } from "react";
import * as THREE from "three";
import { useRollerCoaster } from "@/lib/stores/useRollerCoaster";
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

export function Track() {
  const { trackPoints, isLooped, showWoodSupports, isNightMode } = useRollerCoaster();
  
  const { curve, railData, woodSupports, trackLights } = useMemo(() => {
    if (trackPoints.length < 2) {
      return { curve: null, railData: [], woodSupports: [], trackLights: [] };
    }
    
    const points = trackPoints.map((p) => p.position.clone());
    const curve = new THREE.CatmullRomCurve3(points, isLooped, "catmullrom", 0.5);
    
    const railData: { point: THREE.Vector3; tilt: number; tangent: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    const numSamples = Math.max(trackPoints.length * 20, 100);
    
    // Helper to get loop metadata at parameter t
    const getLoopMetaAt = (t: number): { meta: typeof trackPoints[0]['loopMeta'], theta: number } | null => {
      const n = trackPoints.length;
      const scaledT = t * (isLooped ? n : n - 1);
      const idx = Math.floor(scaledT);
      const frac = scaledT - idx;
      
      const i0 = isLooped ? ((idx % n) + n) % n : Math.min(idx, n - 1);
      const i1 = isLooped ? ((idx + 1) % n) : Math.min(idx + 1, n - 1);
      
      const p0 = trackPoints[i0];
      const p1 = trackPoints[i1];
      
      // If either point has loop metadata, interpolate
      if (p0.loopMeta && p1.loopMeta) {
        // Interpolate theta between the two points
        const theta = p0.loopMeta.theta + frac * (p1.loopMeta.theta - p0.loopMeta.theta);
        return { meta: p0.loopMeta, theta };
      } else if (p0.loopMeta) {
        return { meta: p0.loopMeta, theta: p0.loopMeta.theta };
      } else if (p1.loopMeta) {
        return { meta: p1.loopMeta, theta: p1.loopMeta.theta };
      }
      return null;
    };
    
    // Standard parallel transport initialization
    let prevTangent = curve.getTangent(0).normalize();
    let prevUp = new THREE.Vector3(0, 1, 0);
    const initDot = prevUp.dot(prevTangent);
    prevUp.sub(prevTangent.clone().multiplyScalar(initDot));
    if (prevUp.length() < 0.01) {
      prevUp.set(1, 0, 0);
      const d = prevUp.dot(prevTangent);
      prevUp.sub(prevTangent.clone().multiplyScalar(d));
    }
    prevUp.normalize();
    
    for (let i = 0; i <= numSamples; i++) {
      const t = i / numSamples;
      const point = curve.getPoint(t);
      const tangent = curve.getTangent(t).normalize();
      const tilt = interpolateTilt(trackPoints, t, isLooped);
      
      let up: THREE.Vector3;
      let normal: THREE.Vector3;
      
      // Check if we're in a loop segment
      const loopInfo = getLoopMetaAt(t);
      
      // Track if previous sample was in a loop
      const wasInLoop = i > 0 && getLoopMetaAt((i - 1) / numSamples) !== null;
      
      if (loopInfo && loopInfo.meta) {
        // Use COMPLETE reference frame from loop metadata - including tangent!
        const meta = loopInfo.meta;
        const theta = loopInfo.theta;
        
        // Reference TANGENT for ideal circular loop: d/dθ of position = cos(θ)*forward + sin(θ)*up
        // This is the key fix - we must NOT use the spline tangent which has helical torsion
        const refTangent = new THREE.Vector3()
          .addScaledVector(meta.forward, Math.cos(theta))
          .addScaledVector(meta.up, Math.sin(theta))
          .normalize();
        
        // Inward radial pointing toward loop center: -sin(θ)*forward + cos(θ)*up
        up = new THREE.Vector3()
          .addScaledVector(meta.forward, -Math.sin(theta))
          .addScaledVector(meta.up, Math.cos(theta))
          .normalize();
        
        // Normal (sideways) is always the right vector - constant throughout the loop
        normal = meta.right.clone();
        
        // OVERRIDE the spline tangent with our reference tangent
        // This is critical - the sleeper/tie rotation uses tangent, and helical tangent causes twist
        railData.push({ point, tilt, tangent: refTangent, normal });
        
        prevUp.copy(up);
        prevTangent.copy(refTangent);
        continue; // Skip the normal push at end of loop
      } else {
        // If we just exited a loop, reseed parallel transport from actual spline values
        if (wasInLoop) {
          // Reseed prevTangent with actual spline tangent to prevent seam
          prevTangent.copy(tangent);
          // Reseed prevUp: project previous up onto plane perpendicular to new tangent
          const upDot = prevUp.dot(tangent);
          prevUp.sub(tangent.clone().multiplyScalar(upDot));
          if (prevUp.length() > 0.001) {
            prevUp.normalize();
          } else {
            // Fallback
            prevUp.set(0, 1, 0);
            const d = prevUp.dot(tangent);
            prevUp.sub(tangent.clone().multiplyScalar(d)).normalize();
          }
        }
        // Standard parallel transport for non-loop sections
        if (i === 0) {
          up = prevUp.clone();
        } else {
          const dot = Math.max(-1, Math.min(1, prevTangent.dot(tangent)));
          
          if (dot > 0.9999) {
            up = prevUp.clone();
          } else if (dot < -0.9999) {
            up = prevUp.clone();
          } else {
            const axis = new THREE.Vector3().crossVectors(prevTangent, tangent);
            if (axis.length() > 0.0001) {
              axis.normalize();
              const angle = Math.acos(dot);
              const quat = new THREE.Quaternion().setFromAxisAngle(axis, angle);
              up = prevUp.clone().applyQuaternion(quat);
            } else {
              up = prevUp.clone();
            }
          }
          
          const upDot = up.dot(tangent);
          up.sub(tangent.clone().multiplyScalar(upDot));
          if (up.length() > 0.001) {
            up.normalize();
          } else {
            up = prevUp.clone();
          }
        }
        
        prevTangent.copy(tangent);
        prevUp.copy(up);
        
        normal = new THREE.Vector3().crossVectors(tangent, up).normalize();
      }
      
      railData.push({ point, tilt, tangent, normal });
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
    
    return { curve, railData, woodSupports, trackLights };
  }, [trackPoints, isLooped]);
  
  if (!curve || railData.length < 2) {
    return null;
  }
  
  const leftRail: [number, number, number][] = [];
  const rightRail: [number, number, number][] = [];
  const railOffset = 0.3;
  
  for (let i = 0; i < railData.length; i++) {
    const { point, tilt, tangent, normal } = railData[i];
    
    const tiltRad = (tilt * Math.PI) / 180;
    const tiltCos = Math.cos(tiltRad);
    const tiltSin = Math.sin(tiltRad);
    
    const leftYOffset = railOffset * tiltSin;
    const rightYOffset = -railOffset * tiltSin;
    const horizontalScale = tiltCos;
    
    leftRail.push([
      point.x + normal.x * railOffset * horizontalScale,
      point.y + leftYOffset,
      point.z + normal.z * railOffset * horizontalScale,
    ]);
    rightRail.push([
      point.x - normal.x * railOffset * horizontalScale,
      point.y + rightYOffset,
      point.z - normal.z * railOffset * horizontalScale,
    ]);
  }
  
  return (
    <group>
      <Line
        points={leftRail}
        color="#ff4444"
        lineWidth={4}
      />
      <Line
        points={rightRail}
        color="#ff4444"
        lineWidth={4}
      />
      
      {railData.filter((_, i) => i % 2 === 0).map((data, i) => {
        const { point, tangent, tilt } = data;
        const angle = Math.atan2(tangent.x, tangent.z);
        const tiltRad = (tilt * Math.PI) / 180;
        
        return (
          <mesh
            key={`tie-${i}`}
            position={[point.x, point.y - 0.08, point.z]}
            rotation={[tiltRad, angle, 0]}
          >
            <boxGeometry args={[1.0, 0.08, 0.12]} />
            <meshStandardMaterial color="#8B4513" />
          </mesh>
        );
      })}
      
      {showWoodSupports && woodSupports.map((support, i) => {
        const { pos, tangent, height, tilt } = support;
        const angle = Math.atan2(tangent.x, tangent.z);
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
        
        const tiltRad = (tilt * Math.PI) / 180;
        const tiltCos = Math.cos(tiltRad);
        const tiltSin = Math.sin(tiltRad);
        
        const leftX = pos.x + normal.x * railOffset * tiltCos;
        const leftY = pos.y + railOffset * tiltSin;
        const leftZ = pos.z + normal.z * railOffset * tiltCos;
        const rightX = pos.x - normal.x * railOffset * tiltCos;
        const rightY = pos.y - railOffset * tiltSin;
        const rightZ = pos.z - normal.z * railOffset * tiltCos;
        
        const leftHeight = leftY;
        const rightHeight = rightY;
        
        const legInset = 0.15;
        const leftLegX = pos.x + normal.x * (railOffset - legInset) * tiltCos;
        const leftLegZ = pos.z + normal.z * (railOffset - legInset) * tiltCos;
        const rightLegX = pos.x - normal.x * (railOffset - legInset) * tiltCos;
        const rightLegZ = pos.z - normal.z * (railOffset - legInset) * tiltCos;
        
        const crossbraceHeight = height * 0.6;
        const crossLength = Math.sqrt(Math.pow(railOffset * 2, 2) + Math.pow(crossbraceHeight, 2));
        const crossAngle = Math.atan2(crossbraceHeight, railOffset * 2);
        
        return (
          <group key={`wood-${i}`}>
            <mesh position={[leftLegX, leftHeight / 2, leftLegZ]}>
              <boxGeometry args={[0.12, leftHeight, 0.12]} />
              <meshStandardMaterial color="#8B5A2B" />
            </mesh>
            <mesh position={[rightLegX, rightHeight / 2, rightLegZ]}>
              <boxGeometry args={[0.12, rightHeight, 0.12]} />
              <meshStandardMaterial color="#8B5A2B" />
            </mesh>
            
            {height > 2 && (
              <>
                <mesh 
                  position={[pos.x, height * 0.3, pos.z]} 
                  rotation={[0, angle, 0]}
                >
                  <boxGeometry args={[0.08, 0.08, railOffset * 2.2]} />
                  <meshStandardMaterial color="#A0522D" />
                </mesh>
                <mesh 
                  position={[pos.x, height * 0.6, pos.z]} 
                  rotation={[0, angle, 0]}
                >
                  <boxGeometry args={[0.08, 0.08, railOffset * 2.2]} />
                  <meshStandardMaterial color="#A0522D" />
                </mesh>
              </>
            )}
            
            {height > 3 && (
              <mesh 
                position={[pos.x, height * 0.45, pos.z]} 
                rotation={[crossAngle, angle, 0]}
              >
                <boxGeometry args={[0.06, crossLength * 0.5, 0.06]} />
                <meshStandardMaterial color="#CD853F" />
              </mesh>
            )}
          </group>
        );
      })}
      
      {isNightMode && trackLights.map((light, i) => {
        const { pos, normal } = light;
        const leftX = pos.x + normal.x * 0.5;
        const leftZ = pos.z + normal.z * 0.5;
        const rightX = pos.x - normal.x * 0.5;
        const rightZ = pos.z - normal.z * 0.5;
        const colors = ["#FF0000", "#FFFF00", "#00FF00", "#00FFFF", "#FF00FF"];
        const color = colors[i % colors.length];
        
        return (
          <group key={`light-${i}`}>
            <mesh position={[leftX, pos.y + 0.1, leftZ]}>
              <sphereGeometry args={[0.3, 6, 6]} />
              <meshBasicMaterial color={color} />
            </mesh>
            <mesh position={[rightX, pos.y + 0.1, rightZ]}>
              <sphereGeometry args={[0.3, 6, 6]} />
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
