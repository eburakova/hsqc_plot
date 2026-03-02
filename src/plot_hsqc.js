const margin = { top: 20, right: 20, bottom: 60, left: 60 };
const width = 900 - margin.left - margin.right;
const height = 800 - margin.top - margin.bottom;
const peakSize = 3

const svg = d3
  .select("#plot")
  .attr("width", width + margin.left + margin.right)
  .attr("height", height + margin.top + margin.bottom)
  .append("g")
  .attr("transform", `translate(${margin.left},${margin.top})`);

const defs = svg.append("defs");
defs.append("clipPath")
  .attr("id", "plot-clip")
  .attr("clipPathUnits", "userSpaceOnUse")
  .append("rect")
  .attr("x", 0)
  .attr("y", 0)
  .attr("width", width)
  .attr("height", height);

// Plot area container inside the axes
const plotArea = svg.append("g").attr("class", "plot-area");
plotArea.append("rect")
  .attr("class", "plot-frame")
  .attr("width", width)
  .attr("height", height);

plotArea.attr("clip-path", "url(#plot-clip)");

const clipped = plotArea.append("g").attr("class", "clipped");
const content = clipped.append("g").attr("class", "content");
const axesG = svg.append("g").attr("class", "axes");
const xAxisG = axesG.append("g").attr("class", "x-axis").attr("transform", `translate(0,${height})`);
const yAxisG = axesG.append("g").attr("class", "y-axis");

// make SVG scalable and cover
d3.select("#plot")
  .attr(
    "viewBox",
    `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`,
  )
  .attr("preserveAspectRatio", "xMidYMid meet");
//  .style("pointer-events", "none");
// const tooltip = d3.select("#tooltip");

// Load data
d3.csv("data/N15HSQC_assigned.csv")
  .then((peakData) => {
    // peaks data: w1 is Nitrogen (y-axis in JSON context, but x-axis here), w2 is Hydrogen
    const peaks = peakData.map(d => ({
      assignment: d.Assignment,
      w1: +d.w2, // N15
      w2: +d.w1  // H1
    }));

    // Axis padding controls (fraction of data span, with a floor in ppm)
    const axisPaddingFraction = 0.1;
    const axisPaddingMin = 0.2;

    // Derive axis limits from data with a small padding
    const nExtent = d3.extent(peaks, d => d.w1);
    const hExtent = d3.extent(peaks, d => d.w2);
    const padN = Math.max((nExtent[1] - nExtent[0] || 1) * axisPaddingFraction, axisPaddingMin);
    const padH = Math.max((hExtent[1] - hExtent[0] || 1) * axisPaddingFraction, axisPaddingMin);
    const xLimits = { min: nExtent[0] - padN, max: nExtent[1] + padN };
    const yLimits = { min: hExtent[0] - padH, max: hExtent[1] + padH };

    // Create scales (inverted for NMR convention)
    // xScale: maps ppm (Nitrogen) to screen width
    const xScale = d3
      .scaleLinear()
      .domain([xLimits.max, xLimits.min])
      .range([0, width]);

    // yScale: maps ppm (Hydrogen) to screen height
    const yScale = d3
      .scaleLinear()
      .domain([yLimits.min, yLimits.max])
      .range([0, height]);

    // Initial axes
    const xAxis = d3.axisBottom(xScale).ticks(8).tickFormat(d3.format(".1f"));
    const yAxis = d3.axisLeft(yScale).ticks(8).tickFormat(d3.format(".1f"));
    xAxisG.call(xAxis);
    yAxisG.call(yAxis);

    // Tooltip selection
    // const tooltip = d3.select("#tooltip");

    // Draw peaks
    const nodes = peaks.map((d, i) => ({
      id: i,
      x: xScale(d.w1),
      y: yScale(d.w2),
      fx: xScale(d.w1), // fixed x for peak center
      fy: yScale(d.w2), // fixed y for peak center
      assignment: d.assignment,
      w1: d.w1,
      w2: d.w2
    }));

    const labelNodes = peaks.map((d, i) => ({
      id: i,
      x: xScale(d.w1) + 10,
      y: yScale(d.w2) - 10,
      targetX: xScale(d.w1),
      targetY: yScale(d.w2),
      assignment: d.assignment
    }));

    // Estimate label bounding radius for collisions (approximate text box)
    // Assume ~6px height and ~4px per character width


      /*

============= Good default avoidance parameters: ===============

Label Repulsion: 4
Connector <-> connector ... 0.3
Contour avoidance 0.9
Avoid other connnectors: 1.2
Avoid own peak: 4
Attraction to target: 1
Collision: 0.2 (0.1-0.4)

      */

    labelNodes.forEach(n => {
      const w = Math.max(12, 5 * n.assignment.length);
      const h = 8; // css .label font-size ~8px
      n.radius = Math.sqrt((w * 0.5) ** 2 + (h * 0.5) ** 2);
    });

    // Obstacles for labels to avoid: fixed peak centers
    const obstacles = nodes.map(n => ({
      x: n.fx,
      y: n.fy,
      fx: n.fx,
      fy: n.fy,
      radius: 10
    }));

    // Function to run force layout for labels with configurable repulsion (collision radius)
    function layoutLabels(
      repulsionPx = 4,
      connectorRepulsionStrength = 0.3,
      connectorsAvoidStrength = 1.2,
      avoidAnchorStrength = 4,
      attractStrength = 1,
      collideStrength = 0.2
    ) {
      const simNodes = labelNodes.concat(obstacles);
      
      // Custom force to avoid connectors (line segments between label and its peak)
      function forceConnectors(alpha) {
        const strength = connectorsAvoidStrength;
        const padding = 5; // Distance to maintain from any connector
        
        for (let i = 0, n = labelNodes.length; i < n; ++i) {
          const node = labelNodes[i];
          
          // Each label should avoid ALL other connectors
          for (let j = 0, m = labelNodes.length; j < m; ++j) {
            if (i === j) continue; // Don't avoid your own connector
            
            const other = labelNodes[j];
            const dx_conn = other.targetX - other.x;
            const dy_conn = other.targetY - other.y;
            const dist_conn = Math.sqrt(dx_conn * dx_conn + dy_conn * dy_conn);
            
            // Only avoid if the connector is actually visible (above threshold)
            if (dist_conn < 20) continue; 
            
            // Find point on connector closest to current node
            // Connector is a segment from (other.x, other.y) to (other.targetX, other.targetY)
            const t = Math.max(0, Math.min(1, ((node.x - other.x) * dx_conn + (node.y - other.y) * dy_conn) / (dist_conn * dist_conn)));
            const closestX = other.x + t * dx_conn;
            const closestY = other.y + t * dy_conn;
            
            const dx = node.x - closestX;
            const dy = node.y - closestY;
            const distSq = dx * dx + dy * dy;
            const minDist = padding + node.radius;
            
            if (distSq < minDist * minDist) {
              const dist = Math.sqrt(distSq) || 0.001;
              const push = (minDist - dist) / minDist;
              node.vx += (dx / dist) * push * strength * alpha;
              node.vy += (dy / dist) * push * strength * alpha;
            }
          }
        }
      }

      // Custom force to make connectors repel each other
      function forceConnectorRepulsion(alpha) {
        const strength = connectorRepulsionStrength;
        const threshold = 20; // Connector visibility threshold

        for (let i = 0, n = labelNodes.length; i < n; ++i) {
          const nodeI = labelNodes[i];
          const dxI = nodeI.targetX - nodeI.x;
          const dyI = nodeI.targetY - nodeI.y;
          const distI = Math.sqrt(dxI * dxI + dyI * dyI);
          if (distI < threshold) continue;

          for (let j = i + 1, m = labelNodes.length; j < m; ++j) {
            const nodeJ = labelNodes[j];
            const dxJ = nodeJ.targetX - nodeJ.x;
            const dyJ = nodeJ.targetY - nodeJ.y;
            const distJ = Math.sqrt(dxJ * dxJ + dyJ * dyJ);
            if (distJ < threshold) continue;

            // Simplified repulsion: push label endpoints away if segments are too close
            // We'll check the distance between the midpoints of the connectors
            const midXI = (nodeI.x + nodeI.targetX) / 2;
            const midYI = (nodeI.y + nodeI.targetY) / 2;
            const midXJ = (nodeJ.x + nodeJ.targetX) / 2;
            const midYJ = (nodeJ.y + nodeJ.targetY) / 2;

            const dx = midXI - midXJ;
            const dy = midYI - midYJ;
            const distSq = dx * dx + dy * dy;
            const minDist = 20; // Repulsion distance between midpoints

            if (distSq < minDist * minDist) {
              const dist = Math.sqrt(distSq) || 0.001;
              const push = (minDist - dist) / dist * strength * alpha;
              
              // Only move the labels (x, y) not the fixed targets
              nodeI.vx += dx * push;
              nodeI.vy += dy * push;
              nodeJ.vx -= dx * push;
              nodeJ.vy -= dy * push;
            }
          }
        }
      }

      const simulation = d3.forceSimulation(simNodes)
        .force("x", d3.forceX(d => (d.targetX !== undefined ? d.targetX : d.fx)).strength(attractStrength))
        .force("y", d3.forceY(d => (d.targetY !== undefined ? d.targetY : d.fy)).strength(attractStrength))
        .force("collide", d3.forceCollide(d => (d.fx === undefined ? (d.radius + repulsionPx) : d.radius)).strength(collideStrength))
        .force("connectors", forceConnectors)
        .force("connectorRepulsion", forceConnectorRepulsion)
        .force("avoidAnchor", (alpha) => {
          const minDist = 7 + repulsionPx; // minimum px away from its own peak
          for (let i = 0, n = labelNodes.length; i < n; ++i) {
            const node = labelNodes[i];
            const dx = node.x - node.targetX;
            const dy = node.y - node.targetY;
            let dist = Math.sqrt(dx * dx + dy * dy);
            if (!dist) dist = 0.001;
            if (dist < minDist) {
              const k = (minDist - dist) / minDist;
              node.vx += (dx / dist) * k * avoidAnchorStrength * alpha;
              node.vy += (dy / dist) * k * avoidAnchorStrength * alpha;
            }
          }
        })
        .stop();
        
      for (let i = 0; i < 150; ++i) simulation.tick();
    }

    // Initial layout with default repulsion
    layoutLabels(4, 0.3, 1.2, 4, 0.8, 0.2);

    const peakGroups = content
      .selectAll(".peak-group")
      .data(labelNodes)
      .enter()
      .append("g")
      .attr("class", "peak-group");

    peakGroups
      .append("line")
      .attr("class", "peak-x-1")
      .attr("x1", (d) => d.targetX - peakSize)
      .attr("y1", (d) => d.targetY - peakSize)
      .attr("x2", (d) => d.targetX + peakSize)
      .attr("y2", (d) => d.targetY + peakSize);

    peakGroups
      .append("line")
      .attr("class", "peak-x-2")
      .attr("x1", (d) => d.targetX + peakSize)
      .attr("y1", (d) => d.targetY - peakSize)
      .attr("x2", (d) => d.targetX - peakSize)
      .attr("y2", (d) => d.targetY + peakSize);

    peakGroups
      .append("rect")
      .attr("class", "peak-hitbox")
      .attr("x", (d) => d.targetX - peakSize*2)
      .attr("y", (d) => d.targetY - peakSize*2)
      .attr("width", 30)
      .attr("height", 30)
      .style("fill", "transparent")
      .attr("pointer-events", "all")
      .style("cursor", "pointer")
      .on("mouseover", function (event, d) {
        if (d._animating) return;
        d._animating = true;
        const group = d3.select(this.parentNode);

        // Bring to front to simulate high z-order
        group.raise();

        group.classed("hovered", true);
        group.selectAll("line").transition().duration(200).style("stroke-width", 3);

        // Transition label closer to its peak over 0.2s, but keep a safe gap to avoid overlap/jitter
        const moveScale = 0.2; // base move 50% toward the peak
        const hoverMinDistance = 40; // px clearance to peak center
        const targetX = d.targetX;
        const targetY = d.targetY;
        const startX = d.x;
        const startY = d.y;
        const dx = targetX - startX;
        const dy = targetY - startY;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
        const remaining = Math.max((1 - moveScale) * dist, hoverMinDistance);
        const scale = 1 - remaining / dist;
        const endX = startX + dx * scale;
        const endY = startY + dy * scale;

        group.select(".label")
          .transition()
          .duration(200)
          .attr("x", endX)
          .attr("y", endY);

        // Update connector accordingly
        group.select(".peak-connector")
          .transition()
          .duration(200)
          .attrTween("d", function() {
            return function(t) {
              const currentX = startX + (endX - startX) * t;
              const currentY = startY + (endY - startY) * t;
              return calculateConnectorPath({ ...d, x: currentX, y: currentY });
            };
          })
          .on("end interrupt", () => { d._animating = false; });
      })
      .on("mouseout", function (event, d) {
        d._animating = true;
        const group = d3.select(this.parentNode);
        group.classed("hovered", false);
        group.selectAll("line").transition().duration(200).style("stroke-width", 1.5);

        // Transition label back to original position
        group.select(".label")
          .transition()
          .duration(200)
          .attr("x", d.x)
          .attr("y", d.y);

        // Update connector back
        const targetX = d.targetX;
        const targetY = d.targetY;
        const startX = group.select(".label").attr("x");
        const startY = group.select(".label").attr("y");

        group.select(".peak-connector")
          .transition()
          .duration(200)
          .attrTween("d", function() {
            return function(t) {
              const currentX = +startX + (d.x - startX) * t;
              const currentY = +startY + (d.y - startY) * t;
              return calculateConnectorPath({ ...d, x: currentX, y: currentY });
            };
          })
          .on("end interrupt", () => { d._animating = false; });
      });

    peakGroups
      .append("text")
      .attr("class", "label")
      .attr("x", (d) => d.x)
      .attr("y", (d) => d.y)
      .attr("dominant-baseline", "hanging")
      // .style("display", "none")
      .text((d) => d.assignment);

    // Connector: thin triangle pointing from label to cross
    peakGroups
      .insert("path", ".label") // insert before text
      .attr("class", "peak-connector")
      .style("fill", "#888")
      .style("opacity", 0.4)
      .style("pointer-events", "none");

    const distanceThreshold = 20;

    function calculateConnectorPath(d) {
      const dx = d.targetX - d.x;
      const dy = d.targetY - d.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < distanceThreshold) return null;

      // Estimate label dimensions (align with label background)
      const w = Math.max(12, 5 * d.assignment.length);
      const h = 8; // font-size

      const cx = d.x + w / 2;
      const cy = d.y + h / 2;

      const vdx = d.targetX - cx;
      const vdy = d.targetY - cy;
      const angle = Math.atan2(vdy, vdx);

      let intersectionX = cx;
      let intersectionY = cy;

      const absCos = Math.abs(Math.cos(angle));
      const absSin = Math.abs(Math.sin(angle));

      if (w * absSin <= h * absCos) {
        const signX = Math.cos(angle) > 0 ? 1 : -1;
        intersectionX = cx + signX * (w / 2);
        intersectionY = cy + signX * (w / 2) * Math.tan(angle);
      } else {
        const signY = Math.sin(angle) > 0 ? 1 : -1;
        const tanA = Math.tan(angle);
        intersectionX = cx + (tanA === 0 ? 0 : (signY * (h / 2) / tanA));
        intersectionY = cy + signY * (h / 2);
      }

      const baseWidth = 4;
      
      const x1 = intersectionX + Math.cos(angle + Math.PI/2) * (baseWidth/2);
      const y1 = intersectionY + Math.sin(angle + Math.PI/2) * (baseWidth/2);
      const x2 = intersectionX + Math.cos(angle - Math.PI/2) * (baseWidth/2);
      const y2 = intersectionY + Math.sin(angle - Math.PI/2) * (baseWidth/2);
      const x3 = d.targetX;
      const y3 = d.targetY;
      
      return `M${x1},${y1} L${x2},${y2} L${x3},${y3} Z`;
    }

    function updateConnectors() {
      content.selectAll(".peak-connector")
        .data(labelNodes)
        .attr("d", d => calculateConnectorPath(d));
    }

    // Zoom / pan with synced axes
    const zoom = d3.zoom()
      .scaleExtent([0.5, 8])
      // Allow panning beyond bounds; clip will hide overflow
      .translateExtent([[-width, -height], [width * 2, height * 2]])
      .on("zoom", (event) => {
        const t = event.transform;
        content.attr("transform", t);
        const zx = t.rescaleX(xScale);
        const zy = t.rescaleY(yScale);
        xAxisG.call(d3.axisBottom(zx).ticks(8).tickFormat(d3.format(".1f")));
        yAxisG.call(d3.axisLeft(zy).ticks(8).tickFormat(d3.format(".1f")));
      });

    d3.select("#plot")
      .call(zoom)
      .on("dblclick.zoom", null);

    const resetZoomBtn = document.getElementById("reset-zoom-btn");
    if (resetZoomBtn) {
      resetZoomBtn.addEventListener("click", () => {
        d3.select("#plot")
          .transition()
          .duration(200)
          .call(zoom.transform, d3.zoomIdentity);
      });
    }

    const defaultForces = {
      repulsion: 4,
      connectorRepulsion: 0.3,
      connectorsAvoid: 1.2,
      avoidAnchor: 4,
      attract: 1,
      collide: 0.2,
    };

    const attractSlider = document.getElementById("attract-strength-slider");
    const attractValue = document.getElementById("attract-strength-value");

    const collideSlider = document.getElementById("collide-strength-slider");
    const collideValue = document.getElementById("collide-strength-value");

    if (attractSlider || collideSlider) {
      const apply = () => {
        const attract = attractSlider ? +attractSlider.value : defaultForces.attract;
        const collide = collideSlider ? +collideSlider.value : defaultForces.collide;

        if (attractValue) attractValue.textContent = String(attract);
        if (collideValue) collideValue.textContent = String(collide);

        layoutLabels(
          defaultForces.repulsion,
          defaultForces.connectorRepulsion,
          defaultForces.connectorsAvoid,
          defaultForces.avoidAnchor,
          attract,
          collide
        );
        // Update label positions and connectors in the DOM
        content.selectAll(".label")
          .data(labelNodes)
          .attr("x", d => d.x)
          .attr("y", d => d.y);
          
        updateConnectors();
      };
      // Initialize and listen for changes
      apply();
      if (attractSlider) {
        attractSlider.addEventListener("input", apply);
        attractSlider.addEventListener("change", apply);
      }
      if (collideSlider) {
        collideSlider.addEventListener("input", apply);
        collideSlider.addEventListener("change", apply);
      }
    } else {
      // For main page without slider
      updateConnectors();
    }
  })
  .catch((error) => {
    console.error("Error loading data:", error);
    d3.select("#plot-container")
      .append("p")
      .style("color", "red")
      .text("Error loading data: " + error);
  });
