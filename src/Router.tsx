import { useEffect, useState } from 'react'
import App from './App'
import PlaygroundPage from './pages/PlaygroundPage'

/** Hash routing, so a page is linkable without pulling in a router. Two pages:
 *  the avatar generator at '#/' and the playground at '#/playground'. */
export function Router() {
  const [hash, setHash] = useState(() => window.location.hash)

  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return hash.startsWith('#/playground') ? <PlaygroundPage /> : <App />
}
