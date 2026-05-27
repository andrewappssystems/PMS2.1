# ManageMate Design System Implementation Guide

## Overview
The ManageMate design system is built on a modern, premium SaaS aesthetic with a focus on clarity, hierarchy, and professional appearance. This guide explains how to use the design system components.

## Color Tokens

### CSS Variables
All colors are available as CSS variables in `:root`:

```css
:root {
  /* Primary Green */
  --color-primary: #219377;
  --color-primary-light: #E8F5F0;
  --color-primary-lighter: #F4F9F7;
  --color-primary-dark: #1a6f63;

  /* Accent Yellow */
  --color-accent: #FFBD59;
  --color-accent-light: #FFF4E6;
  --color-accent-lighter: #FFFBF0;

  /* Text & Surface */
  --color-text: #010101;
  --color-text-muted: #525252;
  --color-white: #FFFFFF;
  --color-background: #FFFFFF;
  --color-surface: #F9FAFB;
  --color-surface-alt: #F5F7F6;

  /* Status Colors */
  --color-success: #10B981;
  --color-warning: #F59E0B;
  --color-error: #EF4444;
  --color-info: #3B82F6;
}
```

## Typography

### Font Family
Use Mona Sans for all text:
```css
font-family: 'Mona Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
```

### Font Sizes
- Page Title: 32px (700 weight)
- Section Title: 24px (600 weight)
- Card Title: 18px (600 weight)
- Body Text: 14px (400 weight)
- Small Text: 12px (400 weight)
- Button Text: 14px (600 weight)

## Spacing System (8pt Grid)

Use these tokens for consistent spacing:
```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-12: 48px;
```

## Components

### Buttons

#### Primary Button
```html
<button class="btn btn-primary">Save Changes</button>
```
- Background: Green (#219377)
- Text: White
- Height: 44px
- Radius: 12px

#### Secondary Button
```html
<button class="btn btn-secondary">Cancel</button>
```
- Background: White
- Border: 1px solid green
- Text: Green

#### Accent Button
```html
<button class="btn btn-accent">Important Action</button>
```
- Background: Yellow (#FFBD59)
- Text: Dark (#010101)
- Use sparingly for highlighted actions

#### Ghost Button
```html
<button class="btn btn-ghost">View More</button>
```
- Background: Transparent
- Text: Green

#### Danger Button
```html
<button class="btn btn-danger">Delete</button>
```
- Background: Red (#EF4444)
- Text: White

#### Icon Button
```html
<button class="btn-icon">🔍</button>
```
- Size: 40x40px
- For compact button actions

### Form Controls

```html
<div class="form-group">
  <label for="email">Email Address</label>
  <input 
    type="email" 
    id="email"
    class="form-control"
    placeholder="Enter email"
  >
</div>
```

- Input Height: 48px
- Border Radius: 14px
- Focus: Primary color border + subtle shadow
- Label: 12px, uppercase, 0.12em letter-spacing

### Cards

```html
<div class="card">
  <div class="card-header">
    <h3 class="card-title">Card Title</h3>
  </div>
  <div class="card-body">
    Card content goes here
  </div>
  <div class="card-footer">
    <button class="btn btn-primary">Action</button>
  </div>
</div>
```

- Border Radius: 24px
- Padding: 24px
- Border: 1px solid #F1F1F1
- Shadow: 0 8px 24px rgba(0,0,0,0.04)
- Hover: Elevates slightly (translateY -2px)

### KPI Cards

```html
<div class="kpi-card">
  <div class="kpi-label">Total Revenue</div>
  <div class="kpi-value">UGX 45.2M</div>
  <div class="kpi-meta">↑ 12% vs last month</div>
</div>
```

- Height: 140px minimum
- Displays metrics clearly
- Meta text for trends/details

### Badges

```html
<span class="badge badge-success">Active</span>
<span class="badge badge-warning">Pending</span>
<span class="badge badge-danger">Overdue</span>
<span class="badge badge-info">Draft</span>
```

### Tables

```html
<div class="table-container">
  <table>
    <thead>
      <tr>
        <th>Column 1</th>
        <th>Column 2</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Data 1</td>
        <td>Data 2</td>
      </tr>
    </tbody>
  </table>
</div>
```

- Header Height: 52px
- Row Height: 56px
- Cell Padding: 16px
- Hover: Subtle background change
- Sticky Headers: Enabled by default

### Alerts

```html
<div class="alert alert-success">
  Operation completed successfully!
</div>

<div class="alert alert-warning">
  Please review before proceeding.
</div>

<div class="alert alert-error">
  An error occurred. Please try again.
</div>

<div class="alert alert-info">
  Here's some helpful information.
</div>
```

### Empty States

```html
<div class="empty-state">
  <div class="empty-state-icon">📭</div>
  <div class="empty-state-title">No Results Found</div>
  <div class="empty-state-text">Try adjusting your search filters</div>
</div>
```

## Layout Utilities

### Grid
```html
<div class="grid grid-cols-3 gap-6">
  <!-- 3-column grid with 24px gap -->
</div>
```

### Flexbox
```html
<div class="flex items-center justify-between gap-4">
  <!-- Flex container -->
</div>
```

### Spacing
```html
<div class="p-6 mb-8 pt-4">
  <!-- Padding: 24px, Margin-bottom: 32px, Padding-top: 16px -->
</div>
```

## Dark Mode

The design system includes full dark mode support. Dark mode is automatically activated based on user preference:

```css
@media (prefers-color-scheme: dark) {
  :root {
    --color-background: #0F172A;
    --color-surface: #1E293B;
    --color-text: #F8FAFC;
    /* ... etc */
  }
}
```

## Responsive Design

### Breakpoints
- Mobile: 0-767px
- Tablet: 768-1024px
- Desktop: 1025px+

### Mobile First
All styles should be designed for mobile first, then use media queries for larger screens:

```css
/* Default (mobile) */
.card {
  grid-template-columns: 1fr;
}

/* Tablet and up */
@media (min-width: 768px) {
  .card {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* Desktop */
@media (min-width: 1025px) {
  .card {
    grid-template-columns: repeat(4, 1fr);
  }
}
```

## Micro-interactions

All interactions use smooth transitions:

```css
transition: all 0.25s ease;
```

Common patterns:
- **Buttons on hover:** Slight scale down and color shift
- **Cards on hover:** Lift effect (translateY -2px)
- **Form focus:** Border color change + subtle box-shadow
- **Loading:** Shimmer animation

## Best Practices

### ✅ DO
- Use CSS variables for all colors
- Keep spacing in multiples of 8px
- Maintain consistent border radius
- Use proper semantic HTML
- Test on multiple devices
- Keep font sizes from the scale
- Use the provided component classes

### ❌ DON'T
- Use inline styles for colors (use variables)
- Mix spacing values (stick to the grid)
- Create custom shadows (use provided utilities)
- Over-animate transitions
- Use inconsistent font families
- Mix multiple icon libraries
- Create new components instead of using existing ones

## Implementation Checklist

- [ ] Link to design-system.css in all pages
- [ ] Import Mona Sans font (Google Fonts or local)
- [ ] Use semantic HTML elements (button, input, etc.)
- [ ] Apply appropriate color classes (btn-primary, badge-success)
- [ ] Test responsive design on mobile, tablet, desktop
- [ ] Verify dark mode appearance
- [ ] Test keyboard navigation
- [ ] Validate HTML and CSS
- [ ] Check color contrast ratios (WCAG AA minimum)
- [ ] Test across browsers (Chrome, Firefox, Safari, Edge)

## Resources

- **Mona Sans Font:** [Available on GitHub](https://github.com/githubnext/mona-sans)
- **Lucide Icons:** [Icon set reference](https://lucide.dev)
- **Color Accessibility:** [WebAIM Color Contrast Checker](https://webaim.org/resources/contrastchecker/)
- **Responsive Design:** [MDN Media Queries Guide](https://developer.mozilla.org/en-US/docs/Web/CSS/Media_Queries)

## Support

For questions or updates to the design system, refer to REDESIGN_SUMMARY.md for complete documentation.
