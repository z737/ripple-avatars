import { useEffect, useState } from 'react'
import App from './App'
import PlaygroundPage from './pages/PlaygroundPage'
import { DEFAULT_VERSION, VersionId, versionFromHash, versionRoute } from './versions'

/** Hash routing, so a version is linkable without pulling in a router.
 *
 *  Arriving with no version — or an unknown one — normalises the URL to the
 *  default rather than silently rendering something the address bar does not
 *  name. `replaceState` rather than assignment, so it does not leave a history
 *  entry the back button has to walk through. */
export function Router() {
  const [version, setVersion] = useState<VersionId>(
    () => versionFromHash(window.location.hash) ?? DEFAULT_VERSION
  )

  useEffect(() => {
    const sync = () => {
      const asked = versionFromHash(window.location.hash)
      if (asked) {
        setVersion(asked)
        return
      }
      // Preserve anything after the version, so #/?debug still reaches the views.
      const suffix = window.location.hash.replace(/^#\/?[^?&#]*/, '')
      window.history.replaceState(null, '', versionRoute(DEFAULT_VERSION) + suffix)
      setVersion(DEFAULT_VERSION)
    }

    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  return version === 'v1' ? <App /> : <PlaygroundPage />
}
